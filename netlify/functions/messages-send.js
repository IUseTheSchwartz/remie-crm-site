// File: netlify/functions/messages-send.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  TELNYX_API_KEY,
  TELNYX_FROM_NUMBER,
  TELNYX_MESSAGING_PROFILE_ID,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  },
  body: typeof data === "string" ? data : JSON.stringify(data),
});

async function getRequesterUserId(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    console.warn("[messages-send] getUser error:", error);
    return null;
  }
  return data?.user?.id || null;
}

function normalizeToE164(phone) {
  if (!phone || typeof phone !== "string") return null;
  if (phone.includes(",") || phone.includes(";")) return null;
  const trimmed = phone.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D+/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

    let payload;
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const { to, body, lead_id } = payload || {};
    const requesterId = await getRequesterUserId(event);

    if (!to || !body) return json(400, { error: "Missing required fields: to, body" });
    if (!requesterId) return json(401, { error: "Unauthorized: missing/invalid Supabase token" });
    if (!TELNYX_API_KEY) return json(500, { error: "Server misconfigured: TELNYX_API_KEY missing" });
    if (!TELNYX_FROM_NUMBER) return json(500, { error: "Server misconfigured: TELNYX_FROM_NUMBER is required" });

    const toE164 = normalizeToE164(to);
    if (!toE164) {
      return json(400, {
        error: "Invalid 'to' phone number",
        hint: "Send a single valid E.164 number. US 10-digits are auto-converted to +1##########.",
        received: to,
      });
    }

    const msg = {
      to: toE164,
      from: TELNYX_FROM_NUMBER,
      text: body,
    };
    if (TELNYX_MESSAGING_PROFILE_ID) msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;

    const tRes = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(msg),
    });

    const tData = await tRes.json().catch(() => ({}));

    if (!tRes.ok) {
      console.error("[messages-send] Telnyx error:", tData);

      await supabase.from("messages").insert({
        user_id: requesterId,
        lead_id: lead_id ?? null,
        to_number: toE164,
        from_number: TELNYX_FROM_NUMBER,
        body,
        provider: "telnyx",
        provider_message_id: tData?.data?.id ?? null,
        status: "failed",
        direction: "outbound",      // <-- required by your schema
        error_detail: JSON.stringify(tData).slice(0, 8000),
      });

      return json(502, { error: "Failed to send via Telnyx", details: tData });
    }

    const messageId = tData?.data?.id ?? null;

    const { error: dbErr } = await supabase.from("messages").insert({
      user_id: requesterId,
      lead_id: lead_id ?? null,
      to_number: toE164,
      from_number: TELNYX_FROM_NUMBER,
      body,
      provider: "telnyx",
      provider_message_id: messageId,
      status: "queued",
      direction: "outbound",        // <-- required by your schema
    });

    if (dbErr) {
      console.error("[messages-send] Supabase insert error:", dbErr);
      return json(500, { error: "Message sent but failed to save", messageId });
    }

    return json(200, { success: true, messageId });
  } catch (e) {
    console.error("[messages-send] Unhandled error:", e);
    return json(500, { error: "Server error" });
  }
}
