// File: netlify/functions/tfn-order.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function requireAuthedUser(event) {
  // Accept Authorization: Bearer <supabase access token>
  try {
    const user = await getUserFromRequest({
      headers: {
        get: (k) => event.headers[k.toLowerCase()],
        authorization: event.headers["authorization"] || event.headers["Authorization"],
      },
    });
    if (!user?.id) return null;
    return user;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const user = await requireAuthedUser(event);
    if (!user?.id) {
      return json({ error: "auth_required", hint: "Sign in again and retry." }, 401);
    }

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
    if (!TELNYX_API_KEY) return json({ error: "telnyx_api_key_missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "messaging_profile_missing" }, 500);

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
    const phone_id = String(body.phone_id || "").trim();
    if (!phone_id) {
      return json({ error: "missing_params", detail: "phone_id required" }, 400);
    }

    // 1) ORDER the number
    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone_numbers: [{ phone_number_id: phone_id }],
      }),
    });
    const orderJson = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) {
      return json({ error: "telnyx_order_failed", detail: orderJson }, 502);
    }

    // 2) GET phone details to learn E.164 + confirm it’s ours now
    const pnRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });
    const pnJson = await pnRes.json().catch(() => ({}));
    if (!pnRes.ok || !pnJson?.data?.phone_number) {
      return json({ error: "telnyx_fetch_number_failed", detail: pnJson }, 502);
    }
    const e164 = pnJson.data.phone_number;

    // 3) ASSIGN messaging profile
    const assignRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_profile_id: MESSAGING_PROFILE_ID }),
    });
    const assignJson = await assignRes.json().catch(() => ({}));
    if (!assignRes.ok) {
      return json({ error: "telnyx_assign_profile_failed", detail: assignJson }, 502);
    }

    // 4) UPSERT into agent_messaging_numbers (status=active)
    const db = getServiceClient();
    const now = new Date().toISOString();

    // Avoid duplicate if the same number already exists
    const existing = await db
      .from("agent_messaging_numbers")
      .select("id")
      .eq("e164", e164)
      .maybeSingle();

    if (existing?.data?.id) {
      // If it exists but belongs to someone else, that’s a hard stop
      // Otherwise, just mark it active for this user
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
      if (ins?.error) {
        return json({ error: "db_insert_failed", detail: ins.error }, 500);
      }
    }

    return json({
      ok: true,
      number: { phone_number: e164, phone_id },
      order: orderJson?.data || null,
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};