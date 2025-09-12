// Handles inbound messages (message.received). Point your Messaging Profile's
// *Inbound* webhook at this if you want incoming SMS to appear in your CRM.

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
  const supabase =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
      : null;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return ok({ ok: true, note: "bad json" });
  }

  const data = body?.data || body;
  const eventType = data?.event_type || "";
  const p = data?.payload || {};

  if (!supabase || eventType !== "message.received") return ok({ ok: true });

  const to0 = Array.isArray(p?.to) && p.to.length ? p.to[0] : null;

  await supabase.from("messages").insert({
    user_id: null,          // set if you route per user/team
    lead_id: null,
    provider: "telnyx",
    provider_sid: p?.id || null,
    direction: "incoming",
    from_number: p?.from?.phone_number || null,
    to_number: to0?.phone_number || null,
    body: p?.text || "",
    status: "received",
    status_detail: JSON.stringify({ eventType, payload: p }).slice(0, 8000),
  });

  return ok({ ok: true });
};
