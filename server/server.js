import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PORT = Number(process.env.PORT || 3000);
const PAWAPAY_API_TOKEN = process.env.PAWAPAY_API_TOKEN || "";
const PAWAPAY_BASE_URL = process.env.PAWAPAY_BASE_URL || "https://api.pawapay.io/v2";
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://believetravel.lat").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || PUBLIC_SITE_URL;
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
  await pool.query(`UPDATE believe_payments SET status=$2,provider_transaction_id=$3,failure_reason=$4,pawa_payload=$5,updated_at=NOW(),completed_at=CASE WHEN $2='CONFIRMED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END WHERE deposit_id=$1`, [depositId, status, remoteData.providerTransactionId || null, remoteData?.failureReason?.failureMessage || null, remoteData]);
}

function sendJson(res, status, body, origin = ALLOWED_ORIGIN) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
  const corsOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return sendJson(res, 204, {}, corsOrigin);
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "Believe Travel Payments", database: Boolean(pool), takoRouting: Boolean(TAKO_WEBHOOK_URL) }, corsOrigin);
  }

  if (req.method === "POST" && url.pathname === "/api/payments") {
    try {
      const body = await readJson(req);
      const phoneNumber = normalizePhone(body.telephone);
      const required = [body.nom, body.motif, body.date, body.heure, body.mode];
      if (!phoneNumber || required.some(value => !String(value || "").trim())) {
        return sendJson(res, 400, { error: "Informations de rendez-vous invalides." }, corsOrigin);
      }

      const depositId = randomUUID();
      const appointment = {
        nom: String(body.nom), motif: String(body.motif), date: String(body.date),
        heure: String(body.heure), mode: String(body.mode), note: String(body.note || "")
      };
      if (!pool) throw new Error("DATABASE_URL n’est pas configuré");
      await pool.query(`INSERT INTO believe_payments(deposit_id,amount,currency,status,phone,appointment) VALUES($1,$2,$3,'PENDING',$4,$5)`, [depositId, PAYMENT_AMOUNT, PAYMENT_CURRENCY, phoneNumber, appointment]);
      const payload = {
        depositId,
        returnUrl: `${PUBLIC_SITE_URL}/rendez-vous/confirmation/?depositId=${depositId}`,
        customerMessage: "Believe Travel",
        amountDetails: { amount: PAYMENT_AMOUNT, currency: PAYMENT_CURRENCY },
        phoneNumber,
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
        const local = await pool.query(`SELECT status,amount::text,currency FROM believe_payments WHERE deposit_id=$1`, [paymentMatch[1]]);
        if (!local.rows[0]) return sendJson(res, 404, { error: "Paiement introuvable" }, corsOrigin);
        if (["CONFIRMED", "FAILED"].includes(local.rows[0].status)) return sendJson(res, 200, { depositId: paymentMatch[1], ...local.rows[0] }, corsOrigin);
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
    const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!BELIEVE_ADMIN_KEY || provided !== BELIEVE_ADMIN_KEY) return sendJson(res, 401, { error: "Accès refusé" }, corsOrigin);
    if (!pool) return sendJson(res, 503, { error: "Base de données non configurée" }, corsOrigin);
    const result = await pool.query(`SELECT deposit_id AS "depositId",amount::text,currency,status,phone,appointment,provider_transaction_id AS "providerTransactionId",failure_reason AS "failureReason",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM believe_payments ORDER BY created_at DESC LIMIT 500`);
    return sendJson(res, 200, { payments: result.rows }, corsOrigin);
  }

  return sendJson(res, 404, { error: "Route introuvable" }, corsOrigin);
});

ensureDatabase().then(() => server.listen(PORT, () => console.log(`Believe Travel Payments listening on ${PORT}`))).catch(error => { console.error("database-init", error); process.exit(1); });
