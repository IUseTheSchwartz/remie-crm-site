// Receives Telnyx messaging webhooks (message.sent, message.finalized, etc.)
// and updates the matching row in the `messages` table by provider_sid.
// Responds 200 quickly so Telnyx doesn't mark deliveries as failed.

const { createClient } = require("@supabase/supabase-js");

function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

exports.handler = async (event) => {
  // Always return 200, but do our best to log/parse
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
  const supabase =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
      : null;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.log("[TELNYX STATUS] Bad JSON:", e?.message);
    return ok({ ok: true, note: "bad json" });
  }

  // Telnyx webhook shapes:
  // {
  //   "data": {
  //     "event_type": "message.sent" | "message.finalized" | ...,
  //     "record_type": "event",
  //     "payload": { "id": "...", "text": "...", "to": [{ status: "DELIVERED" | ... }], ... }
  //   }
  // }
  const data = body?.data || body;
  const eventType = data?.event_type || data?.type || "unknown";
  const payload = data?.payload || {};
  const providerSid = payload?.id || data?.id || null;

  console.log("[TELNYX STATUS] type:", eventType, "id:", providerSid);
  if (!supabase || !providerSid) return ok({ ok: true });

  // Decide status
  let status = eventType.replace("message.", ""); // e.g., "sent", "finalized"
  // If Telnyx gives a delivery status, prefer that
  const to0 = Array.isArray(payload?.to) && payload.to.length ? payload.to[0] : null;
  if (to0?.status) {
    status = String(to0.status || "").toLowerCase(); // e.g., "delivered", "undelivered"
  }

  const update = {
    status,
    status_detail: JSON.stringify({ eventType, payload }).slice(0, 8000),
  };
  if (status === "delivered") {
    update.delivered_at = new Date().toISOString();
  }
  if (status === "undelivered" || status === "failed") {
    update.error_detail = JSON.stringify(payload?.errors || payload?.error || {}).slice(0, 8000);
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
