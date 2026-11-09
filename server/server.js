import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PORT = Number(process.env.PORT || 3000);
const PAWAPAY_API_TOKEN = process.env.PAWAPAY_API_TOKEN || "";
const PAWAPAY_BASE_URL = process.env.PAWAPAY_BASE_URL || "https://api.pawapay.io/v2";
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://believetravel.lat").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || PUBLIC_SITE_URL;
const ALLOWED_ORIGINS = new Set([ALLOWED_ORIGIN, PUBLIC_SITE_URL, "https://believetravel.lat", "https://www.believetravel.lat"]);
const DATABASE_URL = process.env.DATABASE_URL || "";
const TAKO_WEBHOOK_URL = process.env.TAKO_WEBHOOK_URL || "";
const BELIEVE_ADMIN_KEY = process.env.BELIEVE_ADMIN_KEY || "";
const PAYMENT_AMOUNT = "6500";
const PAYMENT_CURRENCY = "CDF";
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS believe_payments (
      deposit_id UUID PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'BELIEVE_TRAVEL',
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      phone TEXT NOT NULL,
      appointment JSONB NOT NULL,
      provider_transaction_id TEXT,
      failure_reason TEXT,
      pawa_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS believe_payments_created_idx ON believe_payments(created_at DESC);
    CREATE TABLE IF NOT EXISTS believe_payouts (
      payout_id UUID PRIMARY KEY,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CDF',
      provider TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROCESSING',
      provider_transaction_id TEXT,
      failure_reason TEXT,
      pawa_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS believe_payouts_created_idx ON believe_payouts(created_at DESC);
  `);
}

function localPaymentStatus(remoteStatus) {
  if (remoteStatus === "COMPLETED") return "CONFIRMED";
  if (remoteStatus === "FAILED") return "FAILED";
  return "PROCESSING";
}

async function saveRemoteStatus(depositId, remoteData) {
  if (!pool || !remoteData) return;
  const status = localPaymentStatus(String(remoteData.status || "").toUpperCase());
  await pool.query(`UPDATE believe_payments SET status=$2,provider_transaction_id=$3,failure_reason=$4,pawa_payload=$5,updated_at=NOW(),completed_at=CASE WHEN $2='CONFIRMED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END WHERE deposit_id=$1 AND (status <> 'CANCELLED' OR $2='CONFIRMED')`, [depositId, status, remoteData.providerTransactionId || null, remoteData?.failureReason?.failureMessage || null, remoteData]);
}

async function expireStalePayments() {
  if (!pool) return;
  await pool.query(`UPDATE believe_payments SET status='CANCELLED',failure_reason='Paiement non confirmé dans les 15 minutes',updated_at=NOW() WHERE status IN ('PENDING','PROCESSING') AND created_at <= NOW() - INTERVAL '15 minutes'`);
}

function sendJson(res, status, body, origin = ALLOWED_ORIGIN) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50_000) throw new Error("Requête trop volumineuse");
  }
  return JSON.parse(raw || "{}");
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("243") && digits.length >= 12 && digits.length <= 13) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `243${digits.slice(1)}`;
  return "";
}

function payoutProvider(value) {
  return ({ "M-Pesa": "VODACOM_MPESA_COD", "Airtel Money": "AIRTEL_COD", "Orange Money": "ORANGE_COD" })[String(value || "").trim()] || "";
}

function adminAuthorized(req) {
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return Boolean(BELIEVE_ADMIN_KEY) && provided === BELIEVE_ADMIN_KEY;
}

async function believeBalance(client = pool) {
  const result = await client.query(`SELECT COALESCE((SELECT SUM(amount) FROM believe_payments WHERE status='CONFIRMED'),0)-COALESCE((SELECT SUM(amount) FROM believe_payouts WHERE status IN ('PROCESSING','ENQUEUED','COMPLETED')),0) AS balance`);
  return Math.max(0, Number(result.rows[0]?.balance || 0));
}

async function pawaPay(path, options = {}) {
  if (!PAWAPAY_API_TOKEN) throw new Error("PAWAPAY_API_TOKEN n’est pas configuré");
  const response = await fetch(`${PAWAPAY_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAWAPAY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.failureReason?.failureMessage || data?.message || "Erreur PawaPay");
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return sendJson(res, 204, {}, corsOrigin);
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "Believe Travel Payments", database: Boolean(pool), takoRouting: Boolean(TAKO_WEBHOOK_URL) }, corsOrigin);
  }

  if (req.method === "POST" && url.pathname === "/api/payments") {
    try {
      const body = await readJson(req);
      const whatsappPhone = normalizePhone(body.telephone);
      const paymentPhone = normalizePhone(body.mobileMoneyPhone);
      const required = [body.nom, body.motif, body.date, body.heure, body.mode];
      if (!whatsappPhone || !paymentPhone || required.some(value => !String(value || "").trim())) {
        return sendJson(res, 400, { error: "Informations de rendez-vous invalides." }, corsOrigin);
      }
      const allowedTimes = new Set(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00"]);
      const firstAvailable = new Date("2026-11-16T00:00:00Z");
      const lastAvailable = new Date("2027-02-16T00:00:00Z");
      const chosenDate = new Date(`${body.date}T00:00:00Z`);
      const weekdayRotation = [0, 3, 1, 2, 4];
      const days = Math.round((chosenDate - firstAvailable) / 86400000);
      const week = Math.floor(days / 7);
      const availableDate = Number.isFinite(chosenDate.getTime()) && chosenDate >= firstAvailable && chosenDate <= lastAvailable && (chosenDate.getTime() === lastAvailable.getTime() || days === week * 7 + weekdayRotation[week % weekdayRotation.length]);
      if (!availableDate || !allowedTimes.has(String(body.heure))) {
        return sendJson(res, 400, { error: "La date ou l’heure choisie n’est pas disponible." }, corsOrigin);
      }

      const depositId = randomUUID();
      const appointment = {
        nom: String(body.nom), motif: String(body.motif), date: String(body.date),
        heure: String(body.heure), mode: String(body.mode), note: String(body.note || ""),
        whatsappPhone, mobileMoneyPhone: paymentPhone
      };
      if (!pool) throw new Error("DATABASE_URL n’est pas configuré");
      await pool.query(`INSERT INTO believe_payments(deposit_id,amount,currency,status,phone,appointment) VALUES($1,$2,$3,'PENDING',$4,$5)`, [depositId, PAYMENT_AMOUNT, PAYMENT_CURRENCY, whatsappPhone, appointment]);
      const payload = {
        depositId,
        returnUrl: `${PUBLIC_SITE_URL}/rendez-vous/confirmation/?depositId=${depositId}`,
        customerMessage: "Believe Travel",
        amountDetails: { amount: PAYMENT_AMOUNT, currency: PAYMENT_CURRENCY },
        phoneNumber: paymentPhone,
        language: "FR",
        country: "COD",
        reason: "Confirmation rendez-vous",
        metadata: [
          { platform: "BELIEVE_TRAVEL" },
          { appointmentId: depositId },
          { appointmentDate: String(body.date) }
        ]
      };

      const payment = await pawaPay("/paymentpage", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const redirectUrl = payment.redirectURL || payment.redirectUrl;
      if (payment.status === "REJECTED" || !redirectUrl) {
        await pool.query(`UPDATE believe_payments SET status='FAILED',failure_reason=$2,pawa_payload=$3,updated_at=NOW() WHERE deposit_id=$1`, [depositId, payment?.failureReason?.failureMessage || "Paiement rejeté", payment]);
        return sendJson(res, 502, {
          error: payment?.failureReason?.failureMessage || "Le paiement n’a pas pu être lancé."
        }, corsOrigin);
      }
      await pool.query(`UPDATE believe_payments SET status='PROCESSING',pawa_payload=$2,updated_at=NOW() WHERE deposit_id=$1`, [depositId, payment]);
      return sendJson(res, 201, { depositId, redirectUrl }, corsOrigin);
    } catch (error) {
      console.error("payment-init", error);
      return sendJson(res, 502, { error: error.message || "Service de paiement indisponible." }, corsOrigin);
    }
  }

  const paymentMatch = url.pathname.match(/^\/api\/payments\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && paymentMatch) {
    try {
      if (pool) {
        await expireStalePayments();
        const local = await pool.query(`SELECT status,amount::text,currency FROM believe_payments WHERE deposit_id=$1`, [paymentMatch[1]]);
        if (!local.rows[0]) return sendJson(res, 404, { error: "Paiement introuvable" }, corsOrigin);
        if (["CONFIRMED", "FAILED", "CANCELLED"].includes(local.rows[0].status)) return sendJson(res, 200, { depositId: paymentMatch[1], ...local.rows[0] }, corsOrigin);
      }
      const result = await pawaPay(`/deposits/${paymentMatch[1]}`, { method: "GET" });
      await saveRemoteStatus(paymentMatch[1], result?.data);
      return sendJson(res, 200, {
        depositId: paymentMatch[1],
        status: localPaymentStatus(result?.data?.status || "UNKNOWN"),
        amount: result?.data?.amount,
        currency: result?.data?.currency
      }, corsOrigin);
    } catch (error) {
      console.error("payment-status", error);
      return sendJson(res, error.status === 404 ? 404 : 502, { error: error.message }, corsOrigin);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/pawapay/callback") {
    try {
      const callback = await readJson(req);
      const transactionId = callback.depositId || callback.payoutId || callback.refundId || callback.remittanceId;
      if (!transactionId) return sendJson(res, 400, { error: "Identifiant de transaction manquant" }, corsOrigin);
      const believePayout = callback.payoutId && pool ? await pool.query(`SELECT payout_id FROM believe_payouts WHERE payout_id=$1`, [callback.payoutId]) : { rows: [] };
      if (believePayout.rows[0]) {
        const verified = await pawaPay(`/payouts/${callback.payoutId}`, { method: "GET" });
        const data = verified?.data;
        const local = await pool.query(`SELECT amount::text,currency FROM believe_payouts WHERE payout_id=$1`, [callback.payoutId]);
        if (Number(data?.amount) !== Number(local.rows[0]?.amount) || data?.currency !== local.rows[0]?.currency) return sendJson(res, 400, { error: "Montant ou devise incorrect" }, corsOrigin);
        const status = data?.status === "COMPLETED" ? "COMPLETED" : data?.status === "FAILED" ? "FAILED" : String(data?.status || "PROCESSING").toUpperCase();
        await pool.query(`UPDATE believe_payouts SET status=$2,provider_transaction_id=$3,failure_reason=$4,pawa_payload=$5,updated_at=NOW(),completed_at=CASE WHEN $2='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END WHERE payout_id=$1`, [callback.payoutId, status, data?.providerTransactionId || null, data?.failureReason?.failureMessage || null, data]);
        return sendJson(res, 200, { received: true, platform: "BELIEVE_TRAVEL", type: "PAYOUT" }, corsOrigin);
      }
      const believe = callback.depositId && pool ? await pool.query(`SELECT deposit_id FROM believe_payments WHERE deposit_id=$1`, [callback.depositId]) : { rows: [] };
      if (believe.rows[0]) {
        const verified = await pawaPay(`/deposits/${callback.depositId}`, { method: "GET" });
        const data = verified?.data;
        if (Number(data?.amount) !== Number(PAYMENT_AMOUNT) || data?.currency !== PAYMENT_CURRENCY) return sendJson(res, 400, { error: "Montant ou devise incorrect" }, corsOrigin);
        await saveRemoteStatus(callback.depositId, data);
        return sendJson(res, 200, { received: true, platform: "BELIEVE_TRAVEL" }, corsOrigin);
      }
      if (!TAKO_WEBHOOK_URL) return sendJson(res, 503, { error: "Route TaKo non configurée" }, corsOrigin);
      const forwarded = await fetch(TAKO_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(callback) });
      const forwardedBody = await forwarded.text();
      res.writeHead(forwarded.status, { "Content-Type": forwarded.headers.get("content-type") || "application/json" });
      return res.end(forwardedBody);
    } catch (error) {
      console.error("pawapay-callback", error);
      return sendJson(res, 502, { error: "Vérification impossible" }, corsOrigin);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/admin/payments") {
    if (!adminAuthorized(req)) return sendJson(res, 401, { error: "Accès refusé" }, corsOrigin);
    if (!pool) return sendJson(res, 503, { error: "Base de données non configurée" }, corsOrigin);
    await expireStalePayments();
    const result = await pool.query(`SELECT deposit_id AS "depositId",amount::text,currency,status,phone,appointment,provider_transaction_id AS "providerTransactionId",failure_reason AS "failureReason",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM believe_payments ORDER BY created_at DESC LIMIT 500`);
    const payouts = await pool.query(`SELECT payout_id AS "payoutId",amount::text,currency,provider,phone,status,provider_transaction_id AS "providerTransactionId",failure_reason AS "failureReason",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM believe_payouts ORDER BY created_at DESC LIMIT 100`);
    return sendJson(res, 200, { payments: result.rows, payouts: payouts.rows, availableBalance: await believeBalance() }, corsOrigin);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/payouts") {
    if (!adminAuthorized(req)) return sendJson(res, 401, { error: "Accès refusé" }, corsOrigin);
    if (!pool) return sendJson(res, 503, { error: "Base de données non configurée" }, corsOrigin);
    const body = await readJson(req);
    const amount = Number(body.amount);
    const provider = String(body.provider || "").trim();
    const correspondent = payoutProvider(provider);
    const phone = normalizePhone(body.phone);
    if (!Number.isInteger(amount) || amount <= 0) return sendJson(res, 400, { error: "Montant de retrait invalide." }, corsOrigin);
    if (!correspondent || !phone) return sendJson(res, 400, { error: "Compte Mobile Money invalide." }, corsOrigin);
    const payoutId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('BELIEVE_TRAVEL_PAYOUTS'))`);
      const balance = await believeBalance(client);
      if (amount > balance) throw Object.assign(new Error("Le montant dépasse le solde Believe Travel disponible."), { status: 400 });
      await client.query(`INSERT INTO believe_payouts(payout_id,amount,currency,provider,phone,status) VALUES($1,$2,'CDF',$3,$4,'PROCESSING')`, [payoutId, amount, provider, phone]);
      await client.query("COMMIT");
      const payload = { payoutId, amount: String(amount), currency: "CDF", recipient: { type: "MMO", accountDetails: { provider: correspondent, phoneNumber: phone } }, clientReferenceId: `BELIEVE-${payoutId.slice(0, 8)}`, customerMessage: "Believe Travel", metadata: [{ platform: "BELIEVE_TRAVEL" }, { type: "ADMIN_WITHDRAWAL" }] };
      const payout = await pawaPay("/payouts", { method: "POST", body: JSON.stringify(payload) });
      const accepted = ["ACCEPTED", "DUPLICATE_IGNORED"].includes(String(payout.status || "").toUpperCase());
      if (!accepted) {
        const reason = payout?.failureReason?.failureMessage || "Retrait refusé par pawaPay.";
        await pool.query(`UPDATE believe_payouts SET status='FAILED',failure_reason=$2,pawa_payload=$3,updated_at=NOW() WHERE payout_id=$1`, [payoutId, reason, payout]);
        return sendJson(res, 422, { error: reason }, corsOrigin);
      }
      await pool.query(`UPDATE believe_payouts SET status='PROCESSING',pawa_payload=$2,updated_at=NOW() WHERE payout_id=$1`, [payoutId, payout]);
      return sendJson(res, 202, { ok: true, payoutId, status: "PROCESSING", availableBalance: balance - amount }, corsOrigin);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error.status !== 400) await pool.query(`UPDATE believe_payouts SET status='FAILED',failure_reason=$2,updated_at=NOW() WHERE payout_id=$1`, [payoutId, error.message]).catch(() => {});
      return sendJson(res, error.status || 502, { error: error.message || "Retrait impossible." }, corsOrigin);
    } finally {
      client.release();
    }
  }

  return sendJson(res, 404, { error: "Route introuvable" }, corsOrigin);
});

ensureDatabase().then(() => server.listen(PORT, () => console.log(`Believe Travel Payments listening on ${PORT}`))).catch(error => { console.error("database-init", error); process.exit(1); });
