// netlify/functions/telnyx-voice-webhook.js
// Call Control webhook that:
// 1) Receives events
// 2) When the AGENT answers, transfer the call to the LEAD
// Docs: /v2/calls/:call_control_id/actions/transfer

const crypto = require("crypto");
const fetch = require("node-fetch");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || "";

// Verify Telnyx signature (if secret set)
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;
  try {
    const parts = String(signatureHeader).split(",").map((s) => s.trim());
    const ts = parts.find((p) => p.startsWith("t="))?.split("=")[1];
    const sig = parts.find((p) => p.startsWith("sig="))?.split("=")[1];
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

function decodeClientState(b64) {
  try {
    if (!b64) return null;
    const json = Buffer.from(String(b64), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function transferCall({ callControlId, to, from }) {
  if (!TELNYX_API_KEY) return;
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`;
  const body = { to, from }; // E.164 numbers
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}

exports.handler = async (event) => {
  const rawBody = event.body || "";
  const sig =
    event.headers["telnyx-signature-ed25519"] ||
    event.headers["telnyx-signature"] ||
    event.headers["Telnyx-Signature-Ed25519"] ||
    event.headers["Telnyx-Signature"];

  if (!verifySignature(rawBody, sig)) {
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  const data = payload?.data || {};
  const eventType = data?.event_type || data?.record_type;
  const p = data?.payload || data; // v2 puts fields in data.payload
  const callControlId = p?.call_control_id || null;

  // Pull our state from when we created the call
  const clientState = decodeClientState(p?.client_state || p?.client_state_b64);
  const kind = clientState?.kind;
  const leadNumber = clientState?.lead_number;
  const callerId = clientState?.from_number; // our Telnyx DID chosen server-side

  try {
    switch (eventType) {
      case "call.initiated":
        // Created first leg (agent)
        break;

      case "call.answered":
        // When the AGENT answers the first leg, transfer to the LEAD
        // We only do this for our outbound CRM calls
        if (kind === "crm_outbound" && callControlId && leadNumber && callerId) {
          // Issue transfer to ring the lead, presenting our DID as caller ID
          // Endpoint: /v2/calls/:call_control_id/actions/transfer
          // Ref: Telnyx Voice API commands. 
          transferCall({ callControlId, to: leadNumber, from: callerId });
        }
        break;

      case "call.bridged":
        // Agent and lead are now connected
        break;

      case "call.hangup":
      case "call.ended":
        // End of call; you could log duration here
        break;

      default:
        break;
    }
  } catch {
    // swallow
  }

  // Always ack quickly
  return { statusCode: 200, body: "ok" };
};
