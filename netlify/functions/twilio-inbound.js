// netlify/functions/twilio-inbound.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

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

    const From = params.get("From");   // customer
    const To   = params.get("To");     // your Twilio number
    const Body = params.get("Body") || "";

    // Which user owns this "To" number?
    const { data: num } = await supabase.from("agent_phone_numbers").select("user_id").eq("phone_e164", To).maybeSingle();
    if (!num) return { statusCode: 200, body: "ok" };

    await supabase.from("messages").insert({
      user_id: num.user_id,
      direction: "in",
      from_number: From,
      to_number: To,
      body: Body.trim(),
      status: "received"
    });

    // Optional: auto-reply with HELP/STOP info on first contact
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: `<Response></Response>`
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "err" };
  }
};
