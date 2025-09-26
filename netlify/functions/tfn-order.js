// File: netlify/functions/tfn-order.js
const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      // CORS
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Supabase-Auth",
      "Access-Control-Allow-Methods": "OPTIONS, POST",
    },
    body: JSON.stringify(body),
  };
}

// --- CORS preflight
function isOptions(event) {
  return String(event.httpMethod || "").toUpperCase() === "OPTIONS";
}

/** Extract a Supabase access token from headers/cookies */
function readAccessToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

  const xauth = h["x-supabase-auth"] || h["X-Supabase-Auth"] || "";
  if (xauth.startsWith("Bearer ")) return xauth.slice(7).trim();
  if (xauth) return xauth.trim();

  const cookie = h.cookie || h.Cookie || "";
  if (cookie) {
    for (const part of cookie.split(";").map((p) => p.trim())) {
      if (part.startsWith("sb-access-token=")) return decodeURIComponent(part.split("=")[1] || "");
      if (part.startsWith("sb:token=")) return decodeURIComponent(part.split("=")[1] || "");
    }
  }
  return null;
}

/** Validate token via Supabase Auth REST; use ANON if present, else SERVICE_ROLE */
async function getUserFromAccessToken(token) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const API_KEY =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null;

  if (!SUPABASE_URL || !API_KEY || !token) return null;

  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: API_KEY },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (isOptions(event)) return json({ ok: true });

    if (event.httpMethod !== "POST") return json({ error: "method_not_allowed" }, 405);

    const token = readAccessToken(event);
    const user = await getUserFromAccessToken(token);
    if (!user?.id) return json({ error: "auth_required" }, 401);

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
    if (!TELNYX_API_KEY) return json({ error: "telnyx_api_key_missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "messaging_profile_missing" }, 500);

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
    const phone_id = String(body.phone_id || "").trim();
    if (!phone_id) return json({ error: "missing_params", detail: "phone_id required" }, 400);

    // 1) Order the number
    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_numbers: [{ phone_number_id: phone_id }] }),
    });
    const orderJson = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) return json({ error: "telnyx_order_failed", detail: orderJson }, 502);

    // 2) Fetch the phone record for E.164
    const pnRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });
    const pnJson = await pnRes.json().catch(() => ({}));
    if (!pnRes.ok || !pnJson?.data?.phone_number) {
      return json({ error: "telnyx_fetch_number_failed", detail: pnJson }, 502);
    }
    const e164 = pnJson.data.phone_number;

    // 3) Assign the messaging profile
    const assignRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_profile_id: MESSAGING_PROFILE_ID }),
    });
    const assignJson = await assignRes.json().catch(() => ({}));
    if (!assignRes.ok) return json({ error: "telnyx_assign_profile_failed", detail: assignJson }, 502);

    // 4) Upsert into agent_messaging_numbers
    const db = getServiceClient();
    const now = new Date().toISOString();

    const existing = await db
      .from("agent_messaging_numbers")
      .select("id")
      .eq("e164", e164)
      .maybeSingle();

    if (existing?.data?.id) {
      await db
        .from("agent_messaging_numbers")
        .update({
          user_id: user.id,
          telnyx_phone_id: phone_id,
          telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
          status: "active",
          verified_at: now,
        })
        .eq("id", existing.data.id);
    } else {
      const ins = await db
        .from("agent_messaging_numbers")
        .insert([{
          user_id: user.id,
          e164,
          telnyx_phone_id: phone_id,
          telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
          status: "active",
          verified_at: now,
        }])
        .select("id")
        .maybeSingle();
      if (ins?.error) return json({ error: "db_insert_failed", detail: ins.error }, 500);
    }

    return json({ ok: true, number: { phone_number: e164, phone_id }, order: orderJson?.data || null });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};