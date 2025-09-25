// netlify/functions/telnyx-voice-webhook.js
// Minimal, production-safe Telnyx Call Control webhook.
// - Optional signature verification (set TELNYX_WEBHOOK_SECRET to enable).
// - Always 200s quickly to avoid retries.
// - Clear switch/cases for common events.

const crypto = require("crypto");

// If you enabled "Signed webhooks" in Telnyx Portal, set this ENV:
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || "";

/** Verify Telnyx signature (v2 style). If no secret, skip verification. */
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true; // verification disabled
  if (!signatureHeader) return false;

  // Telnyx sends two comma-separated parts, e.g. "t=...,sig=..."
  try {
    const parts = String(signatureHeader).split(",").map((s) => s.trim());
    const ts = parts.find((p) => p.startsWith("t="))?.split("=")[1];
    const sig = parts.find((p) => p.startsWith("sig="))?.split("=")[1];
    if (!ts || !sig) return false;

    const payload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac("sha256", TELNYX_WEBHOOK_SECRET);
    hmac.update(payload);
    const digest = hmac.digest("hex");

    // constant-time compare
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  // Telnyx posts JSON; we want raw body for signature calc
  const rawBody = event.body || "";
  const sig =
    event.headers["telnyx-signature-ed25519"] ||
    event.headers["telnyx-signature"] ||
    event.headers["Telnyx-Signature-Ed25519"] ||
    event.headers["Telnyx-Signature"];

  // If signature invalid, 400 (unless verification disabled)
  if (!verifySignature(rawBody, sig)) {
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Even on parse error, return 200 to avoid retries
    return { statusCode: 200, body: "ok" };
  }

  // Telnyx Call Control webhook shape
  const data = payload?.data || {};
  const eventType = data?.event_type || data?.record_type; // record_type for legacy

  // Use these IDs for follow-up commands if/when you add actions.
  const callControlId = data?.payload?.call_control_id || data?.call_control_id || null;
  const callLegId = data?.payload?.call_leg_id || data?.call_leg_id || null;

  // QUICKLY acknowledge; do heavy work async if needed.
  // (If you want to queue work, call your own background endpoint here.)
  try {
    switch (eventType) {
      case "call.initiated":
        // Outbound call created.
        // e.g., log to DB, set call status to "dialing"
        break;

      case "call.answered":
        // Media is flowing. Good moment to mark "in-progress".
        // Example: you could start recording or speak text via Call Control command.
        //   POST https://api.telnyx.com/v2/calls/{callControlId}/actions/speak
        // Make sure you store callControlId somewhere if you’ll use it later.
        break;

      case "call.hangup":
      case "call.ended":
        // Call finished. Mark as ended, compute duration, etc.
        break;

      case "call.recording.saved":
      case "call.recording.completed":
        // If you enabled recordings, you’ll receive links/ids here.
        // Save the recording URL for playback in your CRM.
        break;

      // Add more cases as you enable features in your Call Control app:
      // - call.machine.detection.ended
      // - call.sip.headers
      // - call.speaker.started / call.speaker.ended
      // - etc.

      default:
        // Unknown/unused event — safe to ignore.
        break;
    }

    // Always 200 quickly so Telnyx doesn’t retry.
    return { statusCode: 200, body: "ok" };
  } catch (_err) {
    // Swallow errors and still return 200; log elsewhere if you need.
    return { statusCode: 200, body: "ok" };
  }
};
