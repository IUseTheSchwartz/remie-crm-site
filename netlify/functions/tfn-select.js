// File: netlify/functions/tfn-select.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function resolveUserId(event, parsedBody) {
  // 1) Try standard Authorization header
  try {
    const u = await getUserFromRequest(event);
    if (u?.id) return { user_id: u.id, via: "auth_header" };
  } catch {}

  // 2) Try alternate header we added from the client
  try {
    const token =
      event.headers["x-supabase-auth"] ||
      event.headers["X-Supabase-Auth"] ||
      event.headers["x-supabasejwt"] ||
      "";
    if (token) {
      const u = await getUserFromRequest({ headers: { authorization: `Bearer ${token}` } });
      if (u?.id) return { user_id: u.id, via: "x-supabase-auth" };
    }
  } catch {}

  // 3) Fallback: accept a user_id in the JSON body
  if (parsedBody?.user_id) {
    return { user_id: String(parsedBody.user_id), via: "body_user_id" };
  }

  return { user_id: null, via: "none" };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "method_not_allowed" }, 405);

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json({ error: "invalid_json" }, 400); }

    const { user_id, via } = await resolveUserId(event, body);
    if (!user_id) return json({ error: "auth_required" }, 401);

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;
    if (!TELNYX_API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "TELNYX_MESSAGING_PROFILE_ID missing" }, 500);

    const telnyx_phone_id = String(body.telnyx_phone_id || "").trim();
    const e164 = String(body.e164 || "").trim();
    if (!telnyx_phone_id || !e164) return json({ error: "missing_params" }, 400);

    // 1) Order number
    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone_numbers: [{ phone_number_id: telnyx_phone_id }] }),
    });
    const orderJson = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) return json({ error: "telnyx_order_failed", detail: orderJson }, 502);

    // 2) Assign messaging profile
    const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(telnyx_phone_id)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_profile_id: MESSAGING_PROFILE_ID }),
    });
    const patchJson = await patchRes.json().catch(() => ({}));
    if (!patchRes.ok) return json({ error: "telnyx_assign_profile_failed", detail: patchJson }, 502);

    // 3) Save to your DB
    const db = getServiceClient();
    const { data, error } = await db
      .from("agent_messaging_numbers")
      .upsert({
        user_id,
        e164,
        telnyx_phone_id,
        telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
        status: "active",
        verified_at: new Date().toISOString(),
      }, { onConflict: "e164" })
      .select("id")
      .maybeSingle();
    if (error) return json({ error: "db_upsert_failed", detail: error.message }, 500);

    return json({ ok: true, id: data?.id || null, e164, telnyx_phone_id, auth_via: via });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};