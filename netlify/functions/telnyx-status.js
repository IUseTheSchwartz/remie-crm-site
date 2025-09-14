// File: netlify/functions/telnyx-status.js
// Minimal, robust Telnyx status webhook: updates public.messages by provider_sid.

const { getServiceClient } = require("./_supabase");

function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || { ok: true }) };
}

exports.handler = async (event) => {
  const supabase = getServiceClient();

  let body = null;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const data = body?.data || body;
  const eventType = data?.event_type || data?.type || "unknown";
  const payload = data?.payload || {};
  const providerSid = payload?.id || data?.id || null;

  let status = String(eventType || "unknown").replace(/^message\./, ""); // e.g., sent|delivered|undelivered
  const to0 = Array.isArray(payload?.to) && payload.to.length ? payload.to[0] : null;
  if (to0?.status) status = String(to0.status).toLowerCase(); // delivered / undelivered

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

  if (error) console.log("[TELNYX STATUS] DB update error:", error.message);
  return ok({ ok: true });
};
