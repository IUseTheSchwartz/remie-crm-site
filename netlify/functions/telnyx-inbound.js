// netlify/functions/telnyx-inbound.js
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

// Optional: verify Telnyx signature (you can add later with TELNYX_WEBHOOK_SECRET)
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const body = JSON.parse(event.body || "{}");

    // Telnyx wraps events as { data: { event_type, payload: {...} } }
    const evt = body?.data?.event_type;
    const payload = body?.data?.payload || {};

    if (evt !== "message.received") {
      return { statusCode: 200, body: "ignored" };
    }

    const from = payload?.from?.phone_number || "";
    const to = payload?.to?.phone_number || "";
    const text = payload?.text || "";
    const providerSid = payload?.id;

    // ⚠️ If you map by user/number, look up owner by `to`
    // Example: if you store per-user outbound number in a table:
    let userId = null;

    // If you use a single global TFN:
    const { data: users } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);
    userId = users?.[0]?.id || null;

    await supabase.from("messages").insert({
      user_id: userId,
      provider: "telnyx",
      direction: "in",
      from_number: from,
      to_number: to,
      body: text,
      provider_sid: providerSid,
      status: "received",
    });

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("[telnyx-inbound] error:", e);
    return { statusCode: 500, body: "err" };
  }
};
