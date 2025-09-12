const { createClient } = require("@supabase/supabase-js");

/** Basic E.164 normalizer for US/CA
 * - Accepts "+1XXXXXXXXXX" as-is
 * - Strips non-digits from local formats like "(615) 555-1234"
 * - If 10 digits, prefixes +1
 * - If 11 digits and starts with "1", prefixes +
 * - Otherwise returns null
 */
function normalizeToE164_US_CA(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) {
    // remove spaces
    const compact = trimmed.replace(/\s+/g, "");
    // very loose validation: + then 10+ digits
    return /^\+\d{10,15}$/.test(compact) ? compact : null;
  }
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

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

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE,
    TELNYX_API_KEY,
    TELNYX_MESSAGING_PROFILE_ID,
    TELNYX_FROM_NUMBER,
    SITE_URL,
    URL,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return json(500, { error: "Supabase env not set" });
  }
  if (!TELNYX_API_KEY || !TELNYX_FROM_NUMBER) {
    return json(500, { error: "Telnyx env not set (API key / from number)" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { to, body, lead_id, requesterId } = payload || {};
  if (!to || !body) {
    return json(400, { error: "`to` and `body` are required" });
  }
  if (Array.isArray(to)) {
    return json(400, { error: "`to` must be a single phone number string, not an array" });
  }

  const toE164 = normalizeToE164_US_CA(String(to));
  if (!toE164) {
    return json(400, {
      error: "Invalid `to` number",
      hint: "Use a single E.164 number like +16155551234 (US/CA).",
      got: String(to),
    });
  }

  const statusWebhookBase = SITE_URL || URL;
  if (!statusWebhookBase) {
    return json(500, { error: "SITE_URL or URL must be set for webhooks" });
  }
  const statusWebhook = `${statusWebhookBase}/.netlify/functions/telnyx-status`;

  const msg = {
    to: toE164,
    from: TELNYX_FROM_NUMBER,
    text: String(body),
    webhook_url: statusWebhook,
    webhook_failover_url: statusWebhook,
    use_profile_webhooks: false,
  };
  if (TELNYX_MESSAGING_PROFILE_ID) {
    msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  }

  const tRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const telnyxId = tData?.data?.id || tData?.id || null;

  if (!tRes.ok) {
    await supabase.from("messages").insert({
      user_id: requesterId || null,
      lead_id: lead_id ?? null,
      provider: "telnyx",
      provider_sid: telnyxId,
      direction: "outgoing",
      to_number: toE164,
      from_number: TELNYX_FROM_NUMBER,
      body: String(body),
      status: "failed",
      error_detail: JSON.stringify(tData || { status: tRes.status }).slice(0, 8000),
    });

    return json(502, {
      error: "Failed to send via Telnyx",
      telnyx_status: tRes.status,
      telnyx_response: tData,
    });
  }

  const { error: dbErr } = await supabase.from("messages").insert({
    user_id: requesterId || null,
    lead_id: lead_id ?? null,
    provider: "telnyx",
    provider_sid: telnyxId,
    direction: "outgoing",
    to_number: toE164,
    from_number: TELNYX_FROM_NUMBER,
    body: String(body),
    status: "queued",
  });

  if (dbErr) {
    return json(200, {
      ok: true,
      telnyx_id: telnyxId,
      warning: "Sent but failed to insert message row",
      db_error: dbErr.message,
    });
  }

  return json(200, { ok: true, telnyx_id: telnyxId });
};
