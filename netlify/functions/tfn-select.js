// File: netlify/functions/tfn-select.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
function toE164(s) {
  const d = onlyDigits(s);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return String(s || "").startsWith("+") ? String(s) : null;
}

// BODY-FIRST user resolver
async function resolveUserId(event, parsedBody) {
  const bodyUid = parsedBody?.user_id || parsedBody?.userId || parsedBody?.uid;
  if (bodyUid) return { user_id: String(bodyUid), via: "body" };

  const qs = event.queryStringParameters || {};
  const qsUid = qs.user_id || qs.userId || qs.uid;
  if (qsUid) return { user_id: String(qsUid), via: "query" };

  try {
    const u = await getUserFromRequest(event);
    if (u?.id) return { user_id: u.id, via: "auth_header" };
  } catch {}

  try {
    const token =
      event.headers?.["x-supabase-auth"] ||
      event.headers?.["X-Supabase-Auth"] ||
      event.headers?.["x-supabasejwt"] ||
      "";
    if (token) {
      const u = await getUserFromRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      if (u?.id) return { user_id: u.id, via: "x-supabase-auth" };
    }
  } catch {}

  return { user_id: null, via: "none" };
}

// Always returns { ok, status, url, method, headers, data, raw }
async function telnyxFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const res = await fetch(url, opts);

  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k] = v;

  let raw = null;
  let data = null;
  try {
    raw = await res.text();
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  } catch {}

  const shaped = { ok: res.ok, status: res.status, url, method, headers, data, raw };
  if (!res.ok) console.error(`[TELNYX ${method} ${url}] FAILED`, shaped);
  return shaped;
}

async function telnyxOrder({ apiKey, phone_id, e164 }) {
  const payload = phone_id
    ? { phone_numbers: [{ phone_number_id: phone_id }] }
    : { phone_numbers: [{ phone_number: e164 }] };

  return telnyxFetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function telnyxGetAvailById({ apiKey, avail_id }) {
  return telnyxFetch(
    `https://api.telnyx.com/v2/available_phone_numbers/${encodeURIComponent(avail_id)}`,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } }
  );
}

async function telnyxFindIdByNumber({ apiKey, e164, tries = 10, delayMs = 900 }) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const url = new URL("https://api.telnyx.com/v2/phone_numbers");
    url.searchParams.set("filter[phone_number]", e164);

    last = await telnyxFetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const row = last?.data?.data?.[0];
    if (row?.id) return { id: row.id, phone_number: row.phone_number };

    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { id: null, phone_number: null, last };
}

async function telnyxAssignProfile({ apiKey, phone_id, messaging_profile_id }) {
  return telnyxFetch(
    `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_profile_id }),
    }
  );
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "method_not_allowed" }, 405);

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json({ error: "invalid_json", received: event.body }, 400); }

    const { user_id, via } = await resolveUserId(event, body);
    if (!user_id) {
      return json({
        error: "auth_required",
        hint: "Pass user_id in body (user_id|userId|uid) or query, or send Authorization: Bearer <token>.",
      }, 401);
    }

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;
    if (!TELNYX_API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "TELNYX_MESSAGING_PROFILE_ID missing" }, 500);

    const avail_id = String(body.telnyx_phone_id || body.phone_number_id || body.id || "").trim();
    const rawNumber = String(body.e164 || body.phone_number || body.number || "").trim();
    let e164 = toE164(rawNumber);

    if (!avail_id && !e164) {
      return json({
        error: "missing_params",
        detail: "Provide available-number id (telnyx_phone_id/id) OR e164 (phone_number).",
        received_keys: Object.keys(body || {}),
      }, 400);
    }

    if (!e164 && avail_id) {
      const avail = await telnyxGetAvailById({ apiKey: TELNYX_API_KEY, avail_id });
      if (!avail.ok && avail.status !== 404) {
        return json({ error: "telnyx_availability_lookup_failed", telnyx: avail }, 502);
      }
      e164 = toE164(avail?.data?.data?.phone_number || "");
    }

    // 1) Order
    const order = await telnyxOrder({ apiKey: TELNYX_API_KEY, phone_id: avail_id || null, e164: e164 || null });
    if (!order.ok) {
      return json({ error: "telnyx_order_failed", telnyx: order, request: { used_avail_id: !!avail_id, used_e164: !!e164 } }, 502);
    }

    let finalPhoneId = order.data?.data?.phone_numbers?.[0]?.id || null;
    let finalE164 = e164 || order.data?.data?.phone_numbers?.[0]?.phone_number || null;

    if (!finalE164 && avail_id) {
      const avail2 = await telnyxGetAvailById({ apiKey: TELNYX_API_KEY, avail_id });
      if (!avail2.ok && avail2.status !== 404) {
        return json({ error: "telnyx_availability_lookup_failed_postorder", telnyx: avail2, order_echo: order }, 502);
      }
      finalE164 = toE164(avail2?.data?.data?.phone_number || "");
    }

    if (!finalPhoneId) {
      if (!finalE164) {
        return json({ error: "missing_phone_id_after_order", order_full: order }, 502);
      }
      const looked = await telnyxFindIdByNumber({ apiKey: TELNYX_API_KEY, e164: finalE164 });
      if (!looked.id) {
        return json({ error: "missing_phone_id_after_order", lookup_for: finalE164, last_inventory_response: looked.last, order_full: order }, 502);
      }
      finalPhoneId = looked.id;
      finalE164 = finalE164 || looked.phone_number;
    }

    // 2) Assign messaging profile (with retry if 404)
    async function tryAssign(idToUse) {
      return telnyxAssignProfile({
        apiKey: TELNYX_API_KEY,
        phone_id: idToUse,
        messaging_profile_id: MESSAGING_PROFILE_ID,
      });
    }

    let assign = await tryAssign(finalPhoneId);

    if (!assign.ok && assign.status === 404 && finalE164) {
      const looked = await telnyxFindIdByNumber({ apiKey: TELNYX_API_KEY, e164: finalE164, tries: 10, delayMs: 900 });
      if (looked?.id) {
        finalPhoneId = looked.id;
        assign = await tryAssign(finalPhoneId);
      } else {
        return json({
          error: "telnyx_assign_profile_failed",
          telnyx: assign,
          context: { attempted_phone_id: finalPhoneId, e164: finalE164, messaging_profile_id: MESSAGING_PROFILE_ID },
          inventory_lookup_last: looked?.last || null,
          hint: "Order likely succeeded but inventory not visible yet; retry later or increase poll time.",
        }, 502);
      }
    }

    if (!assign.ok) {
      return json({ error: "telnyx_assign_profile_failed", telnyx: assign, context: { phone_id: finalPhoneId, e164: finalE164 } }, 502);
    }

    if (!finalE164) finalE164 = assign.data?.data?.phone_number || finalE164;

    // 3) Save to DB
    const db = getServiceClient();
    const { data, error } = await db
      .from("agent_messaging_numbers")
      .upsert(
        {
          user_id,
          e164: finalE164,
          telnyx_phone_id: finalPhoneId,
          telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
          status: "active",
          verified_at: new Date().toISOString(),
        },
        { onConflict: "e164" }
      )
      .select("id")
      .maybeSingle();

    if (error) return json({ error: "db_upsert_failed", detail: error.message }, 500);

    return json({ ok: true, id: data?.id || null, e164: finalE164, telnyx_phone_id: finalPhoneId, auth_via: via });
  } catch (e) {
    console.error("[tfn-select unhandled]", e);
    return json({ error: "unhandled", detail: String(e?.message || e), stack: e?.stack }, 500);
  }
};
