// netlify/functions/messages-send.js
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// Supabase envs (make sure these exist in Netlify → Environment variables)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Telnyx envs (make sure these exist too)
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars");
}
if (!TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !TELNYX_FROM_NUMBER) {
  throw new Error("Missing Telnyx env vars");
}

// Supabase client with service role (server-side only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const authHeader = event.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    // Verify user session with Supabase
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    const user = userData.user;

    const { to, body } = JSON.parse(event.body || "{}");
    if (!to || !body) {
      return { statusCode: 400, body: "Missing 'to' or 'body'" };
    }

    // Call Telnyx SMS API
    const telnyxResp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        from: TELNYX_FROM_NUMBER,
        to,
        text: body,
        messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
      }),
    });

    const telnyxData = await telnyxResp.json();
    if (!telnyxResp.ok) {
      console.error("Telnyx error:", telnyxData);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Telnyx send failed", details: telnyxData }),
      };
    }

    // Save message in Supabase "messages" table
    const { error: dbError } = await supabase.from("messages").insert([
      {
        user_id: user.id,
        to_number: to,
        from_number: TELNYX_FROM_NUMBER,
        body,
        direction: "out",
        status: "queued",
        created_at: new Date().toISOString(),
        telnyx_message_id: telnyxData.data?.id || null,
      },
    ]);

    if (dbError) {
      console.error("Supabase insert error:", dbError);
      return { statusCode: 500, body: "Failed to save message to DB" };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, telnyx: telnyxData }),
    };
  } catch (err) {
    console.error("messages-send error:", err);
    return { statusCode: 500, body: "Server error: " + err.message };
  }
}
