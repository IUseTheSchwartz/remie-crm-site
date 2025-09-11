// File: netlify/functions/messages-send.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ---------------- Env ---------------- */
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  TELNYX_API_KEY,
  TELNYX_FROM_NUMBER,            // REQUIRED (e.g. +18884318203)
  TELNYX_MESSAGING_PROFILE_ID,   // OPTIONAL
} = process.env;

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

/**
 * Normalize a phone string to E.164 (US/CA default).
 * - If already +E.164, keep it.
 * - If 10 digits, assume US and prefix +1.
 * - If 11 digits and starts with 1, make +<digits>.
 * - Otherwise return null.
 * Also rejects commas/semicolons to ensure it's a single number.
 */
function normalizeToE164(phone) {
  if (!phone || typeof phone !== "string") return null;
  if (phone.includes(",") || phone.includes(";")) return null;

  const trimmed = phone.trim();

  // Already E.164?
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;

  // Strip all non-digits
  const digits = trimmed.replace(/\D+/g, "");

  // 10-digit NANP -> +1##########
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;

  // 11 digits starting with 1 -> +###########
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;

  // Anything else: not supported by our simple normalizer
  return null;
}

/* ---------------- Netlify handler ---------------- */
export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { to, body, lead_id } = payload || {};
    const requesterId = await getRequesterUserId(event);

    if (!to || !body) return json(400, { error: "Missing required fields: to, body" });
    if (!requesterId) return json(401, { error: "Unauthorized: missing/invalid Supabase token" });
    if (!TELNYX_API_KEY) return json(500, { error: "Server misconfigured: TELNYX_API_KEY missing" });
    if (!TELNYX_FROM_NUMBER) return json(500, { error: "Server misconfigured: TELNYX_FROM_NUMBER is required" });

    // Normalize destination
    const toE164 = normalizeToE164(to);
    if (!toE164) {
      return json(400, {
        error: "Invalid 'to' phone number",
        hint:
          "Pass a single valid E.164 number. For US numbers, you can send 10 digits and we will convert to +1##########.",
        received: to,
      });
    }

    // Build Telnyx message (single shared number)
    const msg = {
      to: toE164,
      from: TELNYX_FROM_NUMBER,
      text: body,
    };
    if (TELNYX_MESSAGING_PROFILE_ID) msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;

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
        to_number: toE164,
        from_number: TELNYX_FROM_NUMBER,
        body,
        provider: "telnyx",
        provider_message_id: tData?.data?.id ?? null,
        status: "failed",
        error_detail: JSON.stringify(tData).slice(0, 8000),
      });

      return json(502, { error: "Failed to send via Telnyx", details: tData });
    }

    const messageId = tData?.data?.id ?? null;

    // Save success
    const { error: dbErr } = await supabase.from("messages").insert({
      user_id: requesterId,
      lead_id: lead_id ?? null,
      to_number: toE164,
      from_number: TELNYX_FROM_NUMBER,
      body,
      provider: "telnyx",
      provider_message_id: messageId,
      status: "queued",
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
