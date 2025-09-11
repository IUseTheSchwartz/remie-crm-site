// File: netlify/functions/messages-send.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ---------------- Env ---------------- */
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  TELNYX_API_KEY,
  TELNYX_FROM_NUMBER,            // REQUIRED (global shared number, E.164 like +18884318203)
  TELNYX_MESSAGING_PROFILE_ID,   // OPTIONAL (kept if you want to pin a profile)
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn("[messages-send] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
}
if (!TELNYX_API_KEY) {
  console.warn("[messages-send] Missing TELNYX_API_KEY");
}
if (!TELNYX_FROM_NUMBER) {
  console.warn("[messages-send] Missing TELNYX_FROM_NUMBER (required)");
}

/* ---------------- Supabase (admin) ---------------- */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/* ---------------- Helpers ---------------- */
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
  const auth =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    console.warn("[messages-send] getUser error:", error);
    return null;
  }
  return data?.user?.id || null;
}

/* ---------------- Netlify handler ---------------- */
export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(200, { ok: true });
    }
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { to, body, lead_id } = payload || {};
    const requesterId = await getRequesterUserId(event);

    if (!to || !body) {
      return json(400, { error: "Missing required fields: to, body" });
    }
    if (!requesterId) {
      return json(401, { error: "Unauthorized: missing/invalid Supabase token" });
    }
    if (!TELNYX_FROM_NUMBER) {
      return json(500, { error: "Server misconfigured: TELNYX_FROM_NUMBER is required" });
    }

    /* ---------- Build Telnyx message (single global number) ---------- */
    const msg = {
      to,
      from: TELNYX_FROM_NUMBER,
      text: body,
    };
    if (TELNYX_MESSAGING_PROFILE_ID) {
      msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID; // optional
    }

    /* ---------- Send via Telnyx ---------- */
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

      // Record attempt as failed
      await supabase.from("messages").insert({
        user_id: requesterId,
        lead_id: lead_id ?? null,
        to_number: to,
        from_number: TELNYX_FROM_NUMBER,
        body,
        provider: "telnyx",
        provider_message_id: tData?.data?.id ?? null,
        status: "failed",
        error_detail: JSON.stringify(tData).slice(0, 8000),
      });

      return json(502, {
        error: "Failed to send via Telnyx",
        details: tData,
      });
    }

    const messageId = tData?.data?.id ?? null;

    /* ---------- Save success ---------- */
    const { error: dbErr } = await supabase.from("messages").insert({
      user_id: requesterId,
      lead_id: lead_id ?? null,
      to_number: to,
      from_number: TELNYX_FROM_NUMBER,
      body,
      provider: "telnyx",
      provider_message_id: messageId,
      status: "queued",
    });

    if (dbErr) {
      console.error("[messages-send] Supabase insert error:", dbErr);
      return json(500, {
        error: "Message sent but failed to save",
        messageId,
      });
    }

    return json(200, { success: true, messageId });
  } catch (e) {
    console.error("[messages-send] Unhandled error:", e);
    return json(500, { error: "Server error" });
  }
}
