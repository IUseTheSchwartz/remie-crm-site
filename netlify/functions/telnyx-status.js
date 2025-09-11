// netlify/functions/telnyx-status.js
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (["queued", "accepted"].includes(s)) return "queued";
  if (["sending", "delivered"].includes(s)) return s;
  if (["sent"].includes(s)) return "sending";
  if (["undeliverable", "delivery_failed", "rejected"].includes(s)) return "failed";
  return s;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const body = JSON.parse(event.body || "{}");
    const evt = body?.data?.event_type;
    const p = body?.data?.payload || {};

    if (!evt || !p?.id) return { statusCode: 200, body: "ignored" };

    if (evt === "message.finalized" || evt === "message.delivered" || evt === "message.failed") {
      const status = mapStatus(p?.to[0]?.status || p?.delivery_status || p?.status);
      await supabase
        .from("messages")
        .update({ status })
        .eq("provider_sid", p.id);

      return { statusCode: 200, body: "OK" };
    }

    return { statusCode: 200, body: "ignored" };
  } catch (e) {
    console.error("[telnyx-status] error:", e);
    return { statusCode: 500, body: "Internal error" };
  }
};
