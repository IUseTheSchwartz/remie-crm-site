// netlify/functions/twilio-status.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const COST = parseInt(process.env.COST_PER_SEGMENT_CENTS || "1", 10);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    // Validate Twilio signature
    const signature = event.headers["x-twilio-signature"];
    const url = `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}${event.path}`;
    const params = new URLSearchParams(event.body);
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      Object.fromEntries(params)
    );
    if (!valid) return { statusCode: 403, body: "Invalid signature" };

    const MessageStatus = params.get("MessageStatus");   // queued|sent|delivered|failed|undelivered
    const MessageSid    = params.get("MessageSid");
    const NumSegments   = parseInt(params.get("NumSegments") || "1", 10);

    // Find message
    const { data: rows } = await supabase.from("messages").select("id,user_id,price_cents,segments,status").eq("twilio_sid", MessageSid).limit(1);
    const msg = rows?.[0];
    if (!msg) return { statusCode: 200, body: "ok" };

    // Update status
    await supabase.from("messages").update({ status: MessageStatus, segments: NumSegments }).eq("id", msg.id);

    // Adjust wallet: if more than 1 segment, charge the difference; if failed, refund the reserved cost.
    if ((MessageStatus === "sent" || MessageStatus === "delivered")) {
      const extra = Math.max(0, NumSegments - (msg.segments || 1));
      if (extra > 0) {
        await supabase.rpc("sql", {});
        await supabase.from("user_wallets")
          .update({ balance_cents: supabase.rpc }) // placeholder (see note below)
      }
    } else if (MessageStatus === "failed" || MessageStatus === "undelivered") {
      // refund initial reservation
      const { data: w } = await supabase.from("user_wallets").select("balance_cents").eq("user_id", msg.user_id).maybeSingle();
      await supabase.from("user_wallets").update({ balance_cents: (w?.balance_cents || 0) + (msg.price_cents || COST) }).eq("user_id", msg.user_id);
      await supabase.from("messages").update({ price_cents: 0 }).eq("id", msg.id);
    }

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "err" };
  }
};
