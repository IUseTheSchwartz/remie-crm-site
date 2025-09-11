// File: netlify/functions/messages-send.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ---------- Setup Supabase (Service Role) ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/* ---------- Main handler ---------- */
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const { to, body, lead_id, user_id } = JSON.parse(event.body || "{}");

    if (!to || !body || !user_id) {
      return { statusCode: 400, body: "Missing required fields" };
    }

    /* ---------- Send SMS via Telnyx ---------- */
    const telnyxRes = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.TELNYX_MESSAGING_PROFILE_ID,
        to,
        text: body
      })
    });

    const telnyxData = await telnyxRes.json();

    if (!telnyxRes.ok) {
      console.error("Telnyx error:", telnyxData);
      return { statusCode: 500, body: "Failed to send message" };
    }

    const messageId = telnyxData.data?.id || null;

    /* ---------- Save record in Supabase ---------- */
    const { error } = await supabase
      .from("messages")
      .insert({
        user_id,
        lead_id,
        to_number: to,
        body,
        provider: "telnyx",
        provider_message_id: messageId,
        status: "queued"
      });

    if (error) {
      console.error("Supabase insert error:", error);
      return { statusCode: 500, body: "Message sent but failed to save" };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, messageId })
    };
  } catch (err) {
    console.error("Unhandled error:", err);
    return { statusCode: 500, body: "Server error" };
  }
}