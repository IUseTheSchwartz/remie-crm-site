// File: netlify/functions/tfn-select.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// normalize to E.164-ish if user pasted a formatted version
function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }
function toE164(s) {
  const d = onlyDigits(s);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return String(s || "").startsWith("+") ? String(s) : null;
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

    // Accept multiple aliases for safety
    const telnyx_phone_id =
      String(body.telnyx_phone_id || body.phone_number_id || body.id || "").trim();

    const rawNumber =
      String(body.e164 || body.phone_number || body.number || "").trim();
    const e164 = toE164(rawNumber);

    // We can order by either phone_number_id OR phone_number, so don’t fail yet.
    if (!telnyx_phone_id && !e164) {
      return json({
        error: "missing_params",
        detail: "Provide telnyx_phone_id (or id) and/or e164 (or phone_number).",
        received_keys: Object.keys(body || {}),
      }, 400);
    }

    // 1) Order number (prefer id; fallback to phone_number)
    let orderPayload;
    if (telnyx_phone_id) {
      orderPayload = { phone_numbers: [{ phone_number_id: telnyx_phone_id }] };
    } else {
      orderPayload = { phone_numbers: [{ phone_number: e164 }] };
    }

    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(orderPayload),
    });
    const orderJson = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) return json({ error: "telnyx_order_failed", detail: orderJson }, 502);

    // Determine the final phone id to patch. If we ordered by phone_number,
    // Telnyx’s response includes the id in the order items.
    let finalPhoneId = telnyx_phone_id;
    try {
      if (!finalPhoneId) {
        const items = orderJson?.data?.phone_numbers || [];
        if (items.length && items[0].id) finalPhoneId = items[0].id;
      }
    } catch {}

    // 2) Assign messaging profile (requires the phone_number_id)
    if (!finalPhoneId) {
      return json({
        error: "missing_phone_id_after_order",
        detail: "Could not determine phone_number_id from Telnyx order response.",
        telnyx_response_snippet: JSON.stringify(orderJson).slice(0, 400),
      }, 502);
    }

    const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(finalPhoneId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_profile_id: MESSAGING_PROFILE_ID }),
    });
    const patchJson = await patchRes.json().catch(() => ({}));
    if (!patchRes.ok) return json({ error: "telnyx_assign_profile_failed", detail: patchJson }, 502);

    // 3) Save to your DB
    const db = getServiceClient();
    const numberToStore = e164 || patchJson?.data?.phone_number || body.e164 || body.phone_number || null;
    if (!numberToStore) {
      return json({
        error: "missing_e164_to_store",
        detail: "Could not resolve a phone number to store after purchase.",
        telnyx_response_snippet: JSON.stringify(patchJson).slice(0, 400),
      }, 500);
    }

    const { data, error } = await db
      .from("agent_messaging_numbers")
      .upsert({
        user_id,
        e164: numberToStore,
        telnyx_phone_id: finalPhoneId,
        telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
        status: "active",
        verified_at: new Date().toISOString(),
      }, { onConflict: "e164" })
      .select("id")
      .maybeSingle();
    if (error) return json({ error: "db_upsert_failed", detail: error.message }, 500);

    return json({
      ok: true,
      id: data?.id || null,
      e164: numberToStore,
      telnyx_phone_id: finalPhoneId,
      auth_via: via,
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};