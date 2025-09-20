// netlify/functions/telnyx-inbound.js
// Minimal inbound SMS webhook for Telnyx. Logs everything for now.
// (We can uncomment the DB insert once you confirm column names.)

const { getServiceClient } = require("./_supabase");

const ok = (b) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(b || { ok: true }),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return ok({ ok: true, note: "POST only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const data = body?.data || body;
  const payload = data?.payload || {};
  const eventType = data?.event_type || data?.type || "unknown";
  const messageId = payload?.id || data?.id || null;
  const from = payload?.from?.phone_number || payload?.from || null;
  const to = Array.isArray(payload?.to) && payload.to[0]?.phone_number
    ? payload.to[0].phone_number
    : payload?.to || null;
  const text = payload?.text || payload?.body || "";

  console.log("[telnyx-inbound] type:", eventType);
  console.log("[telnyx-inbound] id:", messageId);
  console.log("[telnyx-inbound] from:", from, "to:", to);
  console.log("[telnyx-inbound] text:", text);

  // --- OPTIONAL: save to DB (uncomment after we confirm your column names) ---
  /*
  try {
    const supabase = getServiceClient();

    // Try to link to an existing contact by phone (adjust to your normalization)
    const { data: contacts } = await supabase
      .from("message_contacts")
      .select("id,user_id,phone")
      .eq("phone", from)               // if you store E.164; change if needed
      .limit(1);

    const contact = contacts?.[0] || null;

    const row = {
      provider: "telnyx",
      provider_sid: messageId,
      direction: "inbound",
      from_phone: from,
      to_phone: to,
      body: text,
      status: "received",
      user_id: contact?.user_id || null,
      contact_id: contact?.id || null,
      created_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("messages").insert(row);
    if (error) console.error("[telnyx-inbound] DB insert error:", error.message);
  } catch (e) {
    console.error("[telnyx-inbound] DB block error:", e?.message || e);
  }
  */
  // --------------------------------------------------------------------------

  return ok({ ok: true });
};
