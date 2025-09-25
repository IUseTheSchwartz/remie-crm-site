// netlify/functions/telnyx-voice-webhook.js
// When AGENT answers, transfer to LEAD.
// Adds robust parsing + logging and won't silently skip failures.

const crypto = require("crypto");
const fetch = require("node-fetch");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || "";

function log(...args) {
  try { console.log("[telnyx-webhook]", ...args); } catch {}
}

// Verify Telnyx signature (HMAC-SHA256 v2). If secret absent, allow all.
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;
  try {
    const parts = String(signatureHeader).split(",").map(s => s.trim());
    const ts = parts.find(p => p.startsWith("t="))?.split("=")[1];
    const sig = parts.find(p => p.startsWith("sig="))?.split("=")[1];
    if (!ts || !sig) return false;
    const payload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac("sha256", TELNYX_WEBHOOK_SECRET);
    hmac.update(payload);
    const digest = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

function decodeClientState(any) {
  try {
    if (!any) return null;
    // support raw JSON, base64 JSON, or already-object
    if (typeof any === "object") return any;
    const s = String(any);
    // base64?
    if (/^[A-Za-z0-9+/=]+$/.test(s)) {
      const json = Buffer.from(s, "base64").toString("utf8");
      return JSON.parse(json);
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function transferCall({ callControlId, to, from }) {
  if (!TELNYX_API_KEY) {
    log("transfer skipped: missing TELNYX_API_KEY");
    return { ok: false, skipped: "no_api_key" };
  }
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`;
  const body = { to, from };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    log("transfer failed", resp.status, data);
    return { ok: false, status: resp.status, data };
  }
  log("transfer ok", { to, from });
  return { ok: true };
}

exports.handler = async (event) => {
  const rawBody = event.body || "";
  const sig =
    event.headers["telnyx-signature"] ||
    event.headers["telnyx-signature-ed25519"] ||
    event.headers["Telnyx-Signature"] ||
    event.headers["Telnyx-Signature-Ed25519"];

  if (!verifySignature(rawBody, sig)) {
    log("invalid signature");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    log("json parse error");
    return { statusCode: 200, body: "ok" };
  }

  const data = payload?.data || {};
  const eventType = data?.event_type || data?.record_type;
  const p = data?.payload || data; // support both shapes

  const callControlId =
    p?.call_control_id ||
    p?.call_control_ids?.[0] || // some events carry arrays
    null;

  const clientState =
    decodeClientState(p?.client_state) ||
    decodeClientState(p?.client_state_b64);

  const kind = clientState?.kind;
  const leadNumber = clientState?.lead_number;
  const fromNumber = clientState?.from_number;

  // minimal log (no PII beyond area codes)
  log("event", eventType, {
    hasCallControlId: !!callControlId,
    kind,
    leadSample: leadNumber ? String(leadNumber).slice(0, 4) + "..." : null,
  });

  try {
    switch (eventType) {
      case "call.answered": {
        // Only transfer for our outbound agent leg
        if (kind === "crm_outbound" && callControlId && leadNumber && fromNumber) {
          await transferCall({
            callControlId,
            to: leadNumber,
            from: fromNumber,
          });
        } else {
          log("answered but missing fields", {
            hasCallControlId: !!callControlId,
            hasLead: !!leadNumber,
            hasFrom: !!fromNumber,
            kind,
          });
        }
        break;
      }
      // (optional) log helpful events
      case "call.initiated":
      case "call.bridged":
      case "call.hangup":
      case "call.ended":
      case "call.transfer.initiated":
      case "call.transfer.completed":
        log("info", eventType);
        break;
      default:
        // ignore noisy events
        break;
    }
  } catch (e) {
    log("handler error", e?.message);
  }

  return { statusCode: 200, body: "ok" };
};
