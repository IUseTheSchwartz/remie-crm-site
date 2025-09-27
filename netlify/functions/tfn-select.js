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

// BODY-first: allow user_id in body or query; else fall back to auth header
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

/* ---- Telnyx fetch wrapper: always returns full details ---- */
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

/* ---- Telnyx helpers ---- */
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

// Optional utility: inventory lookup by E.164 (we don't store the ID, but handy for 409 path)
async function telnyxFindIdByNumber({ apiKey, e164, tries = 8, delayMs = 800 }) {
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
    if (!TELNYX_API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);

    // Early exit: if user already has an active number, do NOT buy again
    const db = getServiceClient();
    const { data: existing } = await db
      .from("agent_messaging_numbers")
      .select("e164, status")
      .eq("user_id", user_id)
      .limit(1)
      .maybeSingle();

    if (existing?.e164) {
      return json({
        ok: true,
        e164: existing.e164,
        already_had_number: true,
        status: existing.status || "active",
        auth_via: via,
        note: "User already has a messaging number; skipping new purchase.",
      });
    }

    // Accept either available-number id OR a phone_number (E.164)
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

    // If only avail_id was provided, fetch its phone_number first (pre-order)
    if (!e164 && avail_id) {
      const avail = await telnyxGetAvailById({ apiKey: TELNYX_API_KEY, avail_id });
      if (!avail.ok && avail.status !== 404) {
        return json({ error: "telnyx_availability_lookup_failed", telnyx: avail }, 502);
      }
      e164 = toE164(avail?.data?.data?.phone_number || "");
    }
    if (!e164) {
      return json({ error: "could_not_determine_e164", telnyx_hint: { avail_id } }, 400);
    }

    // 1) Order the number
    let order = await telnyxOrder({ apiKey: TELNYX_API_KEY, phone_id: avail_id || null, e164 });

    // If Telnyx says “already purchased” (409/85001), treat as success-if-owned
    if (!order.ok && order.status === 409) {
      const code = order?.data?.errors?.[0]?.code;
      if (code === "85001") {
        // Try to confirm it's really in our account inventory
        const looked = await telnyxFindIdByNumber({ apiKey: TELNYX_API_KEY, e164, tries: 8, delayMs: 800 });
        if (!looked?.id) {
          return json({
            error: "telnyx_order_conflict_not_in_inventory",
            detail: "Telnyx reports the number is already purchased, but it isn't visible in your inventory.",
            telnyx: order,
            attempted_number: e164,
          }, 502);
        }
        // Proceed to save as success
        const { data: up, error: upErr } = await db
          .from("agent_messaging_numbers")
          .upsert(
            {
              user_id,
              e164,
              status: "active",
              verified_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )
          .select("id")
          .maybeSingle();

        if (upErr) return json({ error: "db_upsert_failed", detail: upErr.message }, 500);
        return json({ ok: true, id: up?.id || null, e164, auth_via: via, note: "Used existing purchase." });
      }
    }

    if (!order.ok) {
      return json(
        { error: "telnyx_order_failed", telnyx: order, request: { used_avail_id: !!avail_id, used_e164: !!e164 } },
        502
      );
    }

    // 2) Save to DB (minimal fields; one-number-per-user)
    const { data: saved, error: saveErr } = await db
      .from("agent_messaging_numbers")
      .upsert(
        {
          user_id,
          e164,
          status: "active",
          verified_at: new Date().toISOString(),
        },
        { onConflict: "user_id" } // <= enforce one number per user
      )
      .select("id")
      .maybeSingle();

    if (saveErr) return json({ error: "db_upsert_failed", detail: saveErr.message }, 500);

    return json({
      ok: true,
      id: saved?.id || null,
      e164,
      auth_via: via,
      note: "Number purchased and linked. Messaging profile not auto-attached.",
    });
  } catch (e) {
    console.error("[tfn-select unhandled]", e);
    return json({ error: "unhandled", detail: String(e?.message || e), stack: e?.stack }, 500);
  }
};
