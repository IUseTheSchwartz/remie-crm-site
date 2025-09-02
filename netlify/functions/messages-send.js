// netlify/functions/messages-send.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const COST = parseInt(process.env.COST_PER_SEGMENT_CENTS || "1", 10);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing auth" };

    // Identify the user from Supabase JWT
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return { statusCode: 401, body: "Invalid auth" };

    const { to, body, contact_id } = JSON.parse(event.body || "{}");
    if (!to || !body) return { statusCode: 400, body: "to and body required" };

    // Reserve 1 segment (1¢)
    const { data: wallet } = await supabase.from("user_wallets").select("balance_cents").eq("user_id", user.id).maybeSingle();
    if (!wallet || wallet.balance_cents < COST) return { statusCode: 402, body: "Insufficient balance" };
    await supabase.rpc("sql", { /* noop: you can implement debit in a single SQL function if you prefer */ });

    await supabase.from("user_wallets")
      .update({ balance_cents: wallet.balance_cents - COST })
      .eq("user_id", user.id);

    // Send via Twilio Messaging Service
    const msg = await twilioClient.messages.create({
      to,
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      statusCallback: `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}/.netlify/functions/twilio-status`
    });

    // Log the message
    await supabase.from("messages").insert({
      user_id: user.id,
      contact_id: contact_id || null,
      direction: "out",
      to_number: to,
      body,
      status: "queued",
      twilio_sid: msg.sid,
      segments: 1,
      price_cents: COST
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, sid: msg.sid }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Send failed" };
  }
};
