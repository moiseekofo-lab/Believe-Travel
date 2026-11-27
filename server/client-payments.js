import { createHash, randomBytes, randomUUID } from "node:crypto";

const digest = key => createHash("sha256").update(key).digest("hex");
const validAmount = value => /^[1-9]\d{0,11}$/.test(String(value));

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
  `);
}

export async function refreshInstallment(pool, pawaPay, id) {
  const { rows: [entry] } = await pool.query(
    "SELECT amount,status FROM believe_client_installments WHERE id=$1", [id]
  );
  if (!entry) return false;
  if (entry.status !== "PENDING") return true;
  const { data } = await pawaPay(`/deposits/${id}`, { method: "GET" });
  if (data?.status === "FAILED") {
    await pool.query("UPDATE believe_client_installments SET status='FAILED' WHERE id=$1 AND status='PENDING'", [id]);
  } else if (data?.status === "COMPLETED" && data.currency === "CDF" && Number(data.amount) === Number(entry.amount)) {
    await pool.query("UPDATE believe_client_installments SET status='CONFIRMED' WHERE id=$1 AND status='PENDING'", [id]);
  }
  return true;
}

export async function clientPayments({ req, path, pool, send, readJson, adminAuthorized, normalizePhone, pawaPay, site }) {
  if (!pool) return send(503, { error: "Espace client indisponible." });
  if (path === "/api/admin/clients") {
    if (!adminAuthorized(req)) return send(401, { error: "Accès refusé." });
    if (req.method === "GET") {
      const { rows } = await pool.query("SELECT id,name,total,revoked FROM believe_client_accounts ORDER BY name");
      return send(200, { accounts: rows });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.revoke && /^[\da-f-]{36}$/i.test(body.revoke)) {
        await pool.query("UPDATE believe_client_accounts SET revoked=true WHERE id=$1", [body.revoke]);
        return send(200, { ok: true });
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120 || !validAmount(body.total)) return send(400, { error: "Nom ou total CDF invalide." });
      const key = randomBytes(32).toString("base64url");
      await pool.query("INSERT INTO believe_client_accounts(id,name,key_hash,total) VALUES($1,$2,$3,$4)",
        [randomUUID(), name, digest(key), String(body.total)]);
      return send(201, { key });
    }
  }
  const key = (req.headers.authorization || "").match(/^Bearer ([\w-]{43})$/)?.[1];
  if (!key) return send(401, { error: "Clé invalide." });
  const { rows: [account] } = await pool.query(
    "SELECT id,name,total FROM believe_client_accounts WHERE key_hash=$1 AND NOT revoked", [digest(key)]
  );
  if (!account) return send(401, { error: "Clé invalide ou révoquée." });
  if (path === "/api/client/account" && req.method === "GET") {
    const { rows: pending } = await pool.query(
      "SELECT id FROM believe_client_installments WHERE account_id=$1 AND status='PENDING'", [account.id]
    );
    await Promise.allSettled(pending.map(({ id }) => refreshInstallment(pool, pawaPay, id)));
    const { rows: installments } = await pool.query(
      "SELECT amount,status,created_at, CASE WHEN status='PENDING' THEN redirect_url END AS resume_url FROM believe_client_installments WHERE account_id=$1 ORDER BY created_at DESC", [account.id]
    );
    const paid = installments.filter(row => row.status === "CONFIRMED").reduce((sum, row) => sum + Number(row.amount), 0);
    return send(200, { name: account.name, total: account.total, paid, remaining: Number(account.total) - paid, installments });
  }
  if (path === "/api/client/installments" && req.method === "POST") {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    if (!phone || !validAmount(body.amount)) return send(400, { error: "Montant en CDF ou numéro Mobile Money invalide." });
    const id = randomUUID();
    const amount = String(body.amount);
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows: [locked] } = await db.query("SELECT total,revoked FROM believe_client_accounts WHERE id=$1 FOR UPDATE", [account.id]);
      const { rows: [balance] } = await db.query(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE status='CONFIRMED'),0) AS paid, COUNT(*) FILTER (WHERE status='PENDING') AS pending FROM believe_client_installments WHERE account_id=$1", [account.id]
      );
      if (locked.revoked || Number(balance.pending) || Number(amount) > Number(locked.total) - Number(balance.paid)) {
        await db.query("ROLLBACK");
        return send(409, { error: "Vérifiez le solde et attendez la confirmation du versement en cours." });
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
      await pool.query("UPDATE believe_client_installments SET status='FAILED' WHERE id=$1 AND status='PENDING'", [id]);
      return send(422, { error: "Versement refusé par Mobile Money." });
    }
    if (!redirectUrl) return send(502, { error: "Vérifiez le statut du versement dans votre espace." });
    await pool.query("UPDATE believe_client_installments SET redirect_url=$2 WHERE id=$1", [id, redirectUrl]);
    return send(201, { redirectUrl });
  }
  return send(404, { error: "Page introuvable." });
}
