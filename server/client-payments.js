import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const digest = key => createHash("sha256").update(key).digest("hex");
const validAmount = value => /^[1-9]\d{0,11}$/.test(String(value));
const encryptionKey = secret => createHash("sha256").update("believe-client-key:v1:" + secret).digest();

function encryptKey(key, secret, id) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function decryptKey(value, secret, id) {
  const bytes = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

export async function initClientPayments(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS believe_client_accounts (
      id UUID PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL,
      total BIGINT NOT NULL CHECK(total > 0), revoked BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS believe_client_installments (
      id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES believe_client_accounts(id),
      amount BIGINT NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS believe_client_installments_account_idx
      ON believe_client_installments(account_id);
    ALTER TABLE believe_client_installments ADD COLUMN IF NOT EXISTS redirect_url TEXT;
    ALTER TABLE believe_client_accounts ADD COLUMN IF NOT EXISTS contact TEXT NOT NULL DEFAULT '';
    ALTER TABLE believe_client_accounts ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT '';
    ALTER TABLE believe_client_accounts ADD COLUMN IF NOT EXISTS encrypted_key TEXT;
    ALTER TABLE believe_client_accounts ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE believe_client_installments ADD COLUMN IF NOT EXISTS manual_reference TEXT;
    CREATE TABLE IF NOT EXISTS believe_discarded_installments (id UUID PRIMARY KEY);
    WITH discarded AS (
      DELETE FROM believe_client_installments WHERE status='FAILED' RETURNING id
    )
    INSERT INTO believe_discarded_installments(id) SELECT id FROM discarded ON CONFLICT DO NOTHING;
  `);
}

async function discardInstallment(pool, id) {
  await pool.query(`
    WITH discarded AS (
      DELETE FROM believe_client_installments WHERE id=$1 AND status='PENDING' RETURNING id
    )
    INSERT INTO believe_discarded_installments(id) SELECT id FROM discarded ON CONFLICT DO NOTHING
  `, [id]);
}

export async function refreshInstallment(pool, pawaPay, id) {
  const { rows: [entry] } = await pool.query(
    "SELECT amount,status FROM believe_client_installments WHERE id=$1", [id]
  );
  if (!entry) {
    // Recognize repeated callbacks without keeping the failed payment or polling PawaPay again.
    const discarded = await pool.query("SELECT id FROM believe_discarded_installments WHERE id=$1", [id]);
    return discarded.rowCount > 0;
  }
  if (entry.status !== "PENDING") return true;
  const { data } = await pawaPay(`/deposits/${id}`, { method: "GET" });
  if (data?.status === "FAILED") {
    await discardInstallment(pool, id);
  } else if (data?.status === "COMPLETED" && data.currency === "CDF" && Number(data.amount) === Number(entry.amount)) {
    await pool.query("UPDATE believe_client_installments SET status='CONFIRMED' WHERE id=$1 AND status='PENDING'", [id]);
  }
  return true;
}

export async function clientPayments({ req, path, pool, send, readJson, adminAuthorized, normalizePhone, pawaPay, site, keySecret }) {
  if (!pool) return send(503, { error: "Espace client indisponible." });
  if (path === "/api/admin/clients") {
    if (!adminAuthorized(req)) return send(401, { error: "Accès refusé." });
    if (req.method === "GET") {
      const { rows } = await pool.query(`
        SELECT a.id,a.name,a.contact,a.service,a.total,a.revoked,a.archived,
          COALESCE(SUM(i.amount) FILTER (WHERE i.status='CONFIRMED'),0) AS paid,
          COALESCE(jsonb_agg(jsonb_build_object('amount',i.amount,'status',i.status,'date',i.created_at,
            'reference',COALESCE(i.manual_reference,i.id::text)) ORDER BY i.created_at DESC)
            FILTER (WHERE i.id IS NOT NULL),'[]'::jsonb) AS history
        FROM believe_client_accounts a LEFT JOIN believe_client_installments i ON i.account_id=a.id
        GROUP BY a.id ORDER BY a.name
      `);
      return send(200, { accounts: rows });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.accountId) {
        const id = String(body.accountId);
        if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return send(400, { error: "Référence client invalide." });
        if (body.action === "archive" || body.action === "restore") {
          const archived = body.action === "archive";
          const result = await pool.query("UPDATE believe_client_accounts SET archived=$2,revoked=true WHERE id=$1", [id, archived]);
          return send(result.rowCount ? 200 : 404, result.rowCount ? { ok: true } : { error: "Client introuvable." });
        }
        if (body.action === "reveal") {
          const { rows: [account] } = await pool.query("SELECT encrypted_key FROM believe_client_accounts WHERE id=$1 AND NOT archived AND NOT revoked", [id]);
          if (!account?.encrypted_key) return send(409, { error: "Clé indisponible. Générez une nouvelle clé pour ce client." });
          try {
            return send(200, { key: decryptKey(account.encrypted_key, keySecret, id) });
          } catch {
            return send(409, { error: "Clé illisible. Générez une nouvelle clé pour ce client." });
          }
        }
        if (body.action === "rotate") {
          const key = randomBytes(32).toString("base64url");
          const result = await pool.query("UPDATE believe_client_accounts SET key_hash=$2,encrypted_key=$3,revoked=false WHERE id=$1 AND NOT archived",
            [id, digest(key), encryptKey(key, keySecret, id)]);
          return send(result.rowCount ? 200 : 404, result.rowCount ? { key } : { error: "Client actif introuvable." });
        }
        const manual = body.action === "adjust";
        const reference = String(body.reference || "").trim();
        const amount = manual ? body.amount : body.total;
        if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
            !["adjust", "total"].includes(body.action) || !validAmount(amount) ||
            (manual && (!reference || reference.length > 160))) {
          return send(400, { error: "Montant ou référence invalide." });
        }
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          const { rows: [account] } = await db.query("SELECT total FROM believe_client_accounts WHERE id=$1 FOR UPDATE", [id]);
          const { rows: [balance] } = await db.query(
            "SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('PENDING','CONFIRMED')),0) AS reserved FROM believe_client_installments WHERE account_id=$1", [id]
          );
          if (!account || (manual ? Number(amount) + Number(balance.reserved) > Number(account.total) : Number(amount) < Number(balance.reserved))) {
            await db.query("ROLLBACK");
            return send(409, { error: "Montant incompatible avec les versements confirmés ou en attente." });
          }
          if (manual) {
            const adjustment = await db.query(
              `INSERT INTO believe_client_installments(id,account_id,amount,status,manual_reference)
               SELECT $1,$2,$3,'CONFIRMED',$4 WHERE NOT EXISTS (
                 SELECT 1 FROM believe_client_installments WHERE account_id=$2 AND manual_reference=$4
               )`, [randomUUID(), id, String(amount), reference]
            );
            if (!adjustment.rowCount) {
              await db.query("ROLLBACK");
              return send(409, { error: "Cette référence manuelle a déjà été enregistrée." });
            }
          } else await db.query("UPDATE believe_client_accounts SET total=$2 WHERE id=$1", [id, String(amount)]);
          await db.query("COMMIT");
          return send(200, { ok: true });
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
      }
      if (body.revoke && /^[\da-f-]{36}$/i.test(body.revoke)) {
        await pool.query("UPDATE believe_client_accounts SET revoked=true WHERE id=$1", [body.revoke]);
        return send(200, { ok: true });
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const contact = normalizePhone(body.contact);
      const service = typeof body.service === "string" ? body.service.trim() : "";
      if (!name || name.length > 120 || !contact || !service || service.length > 160 || !validAmount(body.total)) {
        return send(400, { error: "Indiquez le nom, un numéro de contact valide, le service et le total en CDF." });
      }
      const key = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await pool.query("INSERT INTO believe_client_accounts(id,name,key_hash,total,contact,service,encrypted_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, name, digest(key), String(body.total), contact, service, encryptKey(key, keySecret, id)]);
      return send(201, { key });
    }
  }
  const key = (req.headers.authorization || "").match(/^Bearer ([\w-]{43})$/)?.[1];
  if (!key) return send(401, { error: "Clé invalide." });
  const { rows: [account] } = await pool.query(
    "SELECT id,name,total,service FROM believe_client_accounts WHERE key_hash=$1 AND NOT revoked", [digest(key)]
  );
  if (!account) return send(401, { error: "Clé invalide ou révoquée." });
  if (path === "/api/client/account" && req.method === "GET") {
    const { rows: pending } = await pool.query(
      "SELECT id FROM believe_client_installments WHERE account_id=$1 AND status='PENDING'", [account.id]
    );
    await Promise.allSettled(pending.map(({ id }) => refreshInstallment(pool, pawaPay, id)));
    const { rows: installments } = await pool.query(
      "SELECT amount,status,created_at,COALESCE(manual_reference,id::text) AS reference, CASE WHEN status='PENDING' THEN redirect_url END AS resume_url FROM believe_client_installments WHERE account_id=$1 ORDER BY created_at DESC", [account.id]
    );
    const paid = installments.filter(row => row.status === "CONFIRMED").reduce((sum, row) => sum + Number(row.amount), 0);
    return send(200, { name: account.name, service: account.service, total: account.total, paid,
      remaining: Number(account.total) - paid, percent: 100 * paid / Number(account.total), installments });
  }
  if (path === "/api/client/installments" && req.method === "POST") {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    if (!phone || !validAmount(body.amount)) return send(400, { error: "Montant en CDF ou numéro Mobile Money invalide." });
    const id = randomUUID();
    const amount = String(body.amount);
    const { rows: pending } = await pool.query(
      "SELECT id FROM believe_client_installments WHERE account_id=$1 AND status='PENDING'", [account.id]
    );
    await Promise.allSettled(pending.map(({ id }) => refreshInstallment(pool, pawaPay, id)));
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows: [locked] } = await db.query("SELECT total,revoked FROM believe_client_accounts WHERE id=$1 FOR UPDATE", [account.id]);
      const { rows: [balance] } = await db.query(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('PENDING','CONFIRMED')),0) AS reserved FROM believe_client_installments WHERE account_id=$1", [account.id]
      );
      if (locked.revoked || Number(amount) > Number(locked.total) - Number(balance.reserved)) {
        await db.query("ROLLBACK");
        return send(409, { error: "Ce montant dépasse le solde disponible après prise en compte des versements en cours." });
      }
      await db.query("INSERT INTO believe_client_installments(id,account_id,amount) VALUES($1,$2,$3)", [id, account.id, amount]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
    const payment = await pawaPay("/paymentpage", {
      method: "POST",
      body: JSON.stringify({
        depositId: id, returnUrl: `${site}/espace-client/`, customerMessage: "Believe Travel",
        amountDetails: { amount, currency: "CDF" }, phoneNumber: phone,
        language: "FR", country: "COD", reason: "Versement frais de service"
      })
    });
    const redirectUrl = payment.redirectURL || payment.redirectUrl;
    if (payment.status === "REJECTED") {
      await discardInstallment(pool, id);
      return send(422, { error: "Versement refusé par Mobile Money." });
    }
    if (!redirectUrl) return send(502, { error: "Vérifiez le statut du versement dans votre espace." });
    await pool.query("UPDATE believe_client_installments SET redirect_url=$2 WHERE id=$1", [id, redirectUrl]);
    return send(201, { redirectUrl });
  }
  return send(404, { error: "Page introuvable." });
}
