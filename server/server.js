import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const PAWAPAY_API_TOKEN = process.env.PAWAPAY_API_TOKEN || "";
const PAWAPAY_BASE_URL = process.env.PAWAPAY_BASE_URL || "https://api.pawapay.io/v2";
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://believetravel.lat").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || PUBLIC_SITE_URL;
const PAYMENT_AMOUNT = "6500";
const PAYMENT_CURRENCY = "CDF";

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
    return sendJson(res, 200, { ok: true, service: "Believe Travel Payments" }, corsOrigin);
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
          { appointmentDate: String(body.date) },
          { appointmentTime: String(body.heure) }
        ]
      };

      const payment = await pawaPay("/paymentpage", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const redirectUrl = payment.redirectURL || payment.redirectUrl;
      if (payment.status === "REJECTED" || !redirectUrl) {
        return sendJson(res, 502, {
          error: payment?.failureReason?.failureMessage || "Le paiement n’a pas pu être lancé."
        }, corsOrigin);
      }
      return sendJson(res, 201, { depositId, redirectUrl }, corsOrigin);
    } catch (error) {
      console.error("payment-init", error);
      return sendJson(res, 502, { error: error.message || "Service de paiement indisponible." }, corsOrigin);
    }
  }

  const paymentMatch = url.pathname.match(/^\/api\/payments\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && paymentMatch) {
    try {
      const result = await pawaPay(`/deposits/${paymentMatch[1]}`, { method: "GET" });
      return sendJson(res, 200, {
        depositId: paymentMatch[1],
        status: result?.data?.status || "UNKNOWN",
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
      if (!callback.depositId) return sendJson(res, 400, { error: "depositId manquant" }, corsOrigin);
      // Never trust a callback alone: verify the final status against PawaPay.
      await pawaPay(`/deposits/${callback.depositId}`, { method: "GET" });
      return sendJson(res, 200, { received: true }, corsOrigin);
    } catch (error) {
      console.error("pawapay-callback", error);
      return sendJson(res, 502, { error: "Vérification impossible" }, corsOrigin);
    }
  }

  return sendJson(res, 404, { error: "Route introuvable" }, corsOrigin);
});

server.listen(PORT, () => console.log(`Believe Travel Payments listening on ${PORT}`));
