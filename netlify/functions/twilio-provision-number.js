// netlify/functions/twilio-provision-number.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, SERVICE_ROLE);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MG_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const { user_id, areaCode = "213" } = JSON.parse(event.body || "{}");
    if (!user_id) return { statusCode: 400, body: "user_id required" };

    // 1) Find an available local number
    const available = await client
      .availablePhoneNumbers("US")
      .local.list({ areaCode, smsEnabled: true, limit: 1 });
    if (!available.length) return { statusCode: 404, body: "No numbers available" };

    // 2) Buy it
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber
    });

    // 3) Attach to Messaging Service
    await client.messaging.v1
      .services(MG_SID)
      .phoneNumbers
      .create({ phoneNumberSid: purchased.sid });

    // 4) Save to Supabase
    await supabase.from("agent_phone_numbers").upsert({
      user_id,
      phone_e164: purchased.phoneNumber,
      phone_sid: purchased.sid,
      messaging_service_sid: MG_SID
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, phone: purchased.phoneNumber }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Provision failed" };
  }
};
