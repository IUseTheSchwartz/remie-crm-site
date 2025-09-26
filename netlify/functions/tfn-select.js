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

// --- user resolver: body > query > auth header ---
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

  return { user_id: null, via: "none" };
}

// --- telnyx fetch helper ---
async function telnyxFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const res = await fetch(url, opts);

  let raw = null, data = null;
  try {
    raw = await res.text();
    try { data = raw ? JSON.parse(raw) : null; } catch {}
  } catch {}

  const shaped = { ok: res.ok, status: res.status, url, method, data, raw };
  if (!res.ok) console.error(`[TELNYX ${method} ${url}] FAILED`, shaped);
  return shaped;
}

// --- telnyx helpers ---
async function telnyxOrder({ apiKey, phone_id, e164 }) {
  const payload = phone_id
    ? { phone_numbers: [{ phone_number_id: phone_id }] }
    : { phone_numbers: [{ phone_number: e164 }] };
  return telnyxFetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function telnyxAssignProfile({ apiKey, phone_id, messaging_profile_id }) {
  return telnyxFetch(
    `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phone_id)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
    if (!user_id) return json({ error: "auth_required" }, 401);

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
    if (!TELNYX_API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "TELNYX_MESSAGING_PROFILE_ID missing" }, 500);

    const raw = String(body.e164 || body.phone_number || body.number || "").trim();
    let e164 = toE164(raw);

    // --- order number ---
    const order = await telnyxOrder({ apiKey: TELNYX_API_KEY, e164 });
    if (!order.ok) {
      return json({ error: "telnyx_order_failed", telnyx: order }, 502);
    }

    const finalPhoneId = order.data?.data?.phone_numbers?.[0]?.id;
    const finalE164 = e164 || order.data?.data?.phone_numbers?.[0]?.phone_number;

    // --- assign profile ---
    const assign = await telnyxAssignProfile({
      apiKey: TELNYX_API_KEY,
      phone_id: finalPhoneId,
      messaging_profile_id: MESSAGING_PROFILE_ID,
    });
    if (!assign.ok) {
      return json({ error: "telnyx_assign_profile_failed", telnyx: assign }, 502);
    }

    // --- save in DB ---
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

    return json({
      ok: true,
      id: data?.id,
      e164: finalE164,
      telnyx_phone_id: finalPhoneId,
      auth_via: via,
    });
  } catch (e) {
    console.error("[tfn-select unhandled]", e);
    return json({ error: "unhandled", detail: String(e?.message || e), stack: e?.stack }, 500);
  }
};
