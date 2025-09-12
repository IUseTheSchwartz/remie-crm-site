// Sends an SMS via Telnyx and writes an outgoing message row to Supabase.
// Also sets a per-message webhook_url so Telnyx can POST delivery/status events
// even if your Messaging Profile has no "outbound" webhook fields.

const { createClient } = require("@supabase/supabase-js");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // ---- Env ----
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE, // <-- you said you use this exact name
    TELNYX_API_KEY,
    TELNYX_MESSAGING_PROFILE_ID,
    TELNYX_FROM_NUMBER, // E164 (e.g., +18xxxxxxxxx)
    SITE_URL, // preferred
    URL,      // Netlify fallback
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return json(500, { error: "Supabase env not set" });
  }
  if (!TELNYX_API_KEY || !TELNYX_FROM_NUMBER) {
    return json(500, { error: "Telnyx env not set (API key / from number)" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // ---- Input ----
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { to, body, lead_id, requesterId } = payload; // requesterId optional
  if (!to || !body) {
    return json(400, { error: "`to` and `body` are required" });
  }

  const toE164 = String(to).trim();
  const statusWebhookBase = SITE_URL || URL;
  if (!statusWebhookBase) {
    return json(500, { error: "SITE_URL or URL must be set for webhooks" });
  }
  const statusWebhook =
    `${statusWebhookBase}/.netlify/functions/telnyx-status`;

  // ---- Send via Telnyx ----
  const msg = {
    to: toE164,
    from: TELNYX_FROM_NUMBER,
    text: body,
    webhook_url: statusWebhook,
    webhook_failover_url: statusWebhook,
    use_profile_webhooks: false, // force using our per-message webhook
  };
  if (TELNYX_MESSAGING_PROFILE_ID) {
    msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  }

  const tRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(msg),
  });

  let tData = null;
  try {
    tData = await tRes.json();
  } catch {
    tData = null;
  }

  // Telnyx message id (if any)
  const telnyxId =
    tData?.data?.id ||
    tData?.id ||
    null;

  if (!tRes.ok) {
    // Write a failed attempt so the UI shows it
    await supabase.from("messages").insert({
      user_id: requesterId || null,
      lead_id: lead_id ?? null,
      provider: "telnyx",
      provider_sid: telnyxId, // keep consistent with status handler
      direction: "outgoing",
      to_number: toE164,
      from_number: TELNYX_FROM_NUMBER,
      body,
      status: "failed",
      error_detail: JSON.stringify(tData || { status: tRes.status }).slice(0, 8000),
    });

    return json(502, {
      error: "Failed to send via Telnyx",
      telnyx_status: tRes.status,
      telnyx_response: tData,
    });
  }

  // Record as queued; webhooks will update status later
  const { error: dbErr } = await supabase.from("messages").insert({
    user_id: requesterId || null,
    lead_id: lead_id ?? null,
    provider: "telnyx",
    provider_sid: telnyxId,
    direction: "outgoing",
    to_number: toE164,
    from_number: TELNYX_FROM_NUMBER,
    body,
    status: "queued",
  });

  if (dbErr) {
    // We still sent the SMS; report the DB issue to help troubleshooting.
    return json(200, {
      ok: true,
      telnyx_id: telnyxId,
      warning: "Sent but failed to insert message row",
      db_error: dbErr.message,
    });
  }

  return json(200, { ok: true, telnyx_id: telnyxId });
};
