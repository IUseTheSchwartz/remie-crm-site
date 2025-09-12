// Minimal + robust Telnyx status webhook.
// Updates the message row by provider_sid and sets only `status` (and optionally `error_detail`).
// This avoids errors when optional columns don't exist in your schema.

const { createClient } = require("@supabase/supabase-js");

function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

exports.handler = async (event) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.log("Missing Supabase env");
    return ok({ ok: true });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.log("[TELNYX STATUS] Bad JSON:", e?.message);
    return ok({ ok: true });
  }

  const data = body?.data || body;
  const eventType = data?.event_type || data?.type || "unknown";
  const payload = data?.payload || {};
  const providerSid = payload?.id || data?.id || null;

  // Decide status string
  let status = eventType.replace("message.", ""); // "sent" | "finalized" | ...
  const to0 = Array.isArray(payload?.to) && payload.to.length ? payload.to[0] : null;
  if (to0?.status) status = String(to0.status).toLowerCase(); // e.g., "delivered", "undelivered"

  if (!providerSid) return ok({ ok: true, note: "no id" });

  const update = { status };
  if (status === "undelivered" || status === "failed") {
    const err = payload?.errors || payload?.error || null;
    if (err) update.error_detail = JSON.stringify(err).slice(0, 8000);
  }

  const { error } = await supabase
    .from("messages")
    .update(update)
    .eq("provider", "telnyx")
    .eq("provider_sid", providerSid);

  if (error) {
    console.log("[TELNYX STATUS] DB update error:", error.message);
  }
  return ok({ ok: true });
};
