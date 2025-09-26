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

// ---- phone helpers ----
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
function toE164(s) {
  const d = onlyDigits(s);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return String(s || "").startsWith("+") ? String(s) : null;
}

// ---- auth helper ----
async function resolveUserId(event, parsedBody) {
  try {
    const u = await getUserFromRequest(event);
    if (u?.id) return { user_id: u.id, via: "auth_header" };
  } catch {}

  try {
    const token =
      event.headers["x-supabase-auth"] ||
      event.headers["X-Supabase-Auth"] ||
      event.headers["x-supabasejwt"] ||
      "";
    if (token) {
      const u = await getUserFromRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      if (u?.id) return { user_id: u.id, via: "x-supabase-auth" };
    }
  } catch {}

  if (parsedBody?.user_id) {
    return { user_id: String(parsedBody.user_id), via: "body_user_id" };
  }
  return { user_id: null, via: "none" };
}

// ---- Telnyx helpers ----
async function telnyxOrder({ apiKey, phone_id, e164 }) {
  const payload = phone_id
    ? { phone_numbers: [{ phone_number_id: phone_id }] }
    : { phone_numbers: [{ phone_number: e164 }] };

  const res = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function telnyxGetAvailById({ apiKey, avail_id }) {
  const res = await fetch(
    `https://api.telnyx.com/v2/available_phone_numbers/${encodeURIComponent(
      avail_id
    )}`,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Poll the inventory until the newly purchased number shows up with an ID
async function telnyxFindIdByNumber({ apiKey, e164, tries = 10, delayMs = 900 }) {
  for (let i = 0; i < tries; i++) {
    const url = new URL("https://api.telnyx.com/v2/phone_numbers");
    url.searchParams.set("filter[phone_number]", e164);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));

    const row = data?.data?.[0];
    if (row?.id) return { id: row.id, phone_number: row.phone_number };

    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { id: null, phone_number: null };
}

async function telnyxAssignProfile({ apiKey, phone_id, messaging_profile_id }) {
  const res = await fetch(
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
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "method_not_allowed" }, 405);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const { user_id, via } = await resolveUserId(event, body);
    if (!user_id) return json({ error: "auth_required" }, 401);

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;
    if (!TELNYX_API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);
    if (!MESSAGING_PROFILE_ID) return json({ error: "TELNYX_MESSAGING_PROFILE_ID missing" }, 500);

    // Accept either available-number id OR a phone_number (E.164)
    const avail_id = String(
      body.telnyx_phone_id || body.phone_number_id || body.id || ""
    ).trim();

    const raw = String(body.e164 || body.phone_number || body.number || "").trim();
    let e164 = toE164(raw);

    if (!avail_id && !e164) {
      return json(
        {
          error: "missing_params",
          detail: "Provide available-number id (telnyx_phone_id/id) OR e164 (phone_number).",
          received_keys: Object.keys(body || {}),
        },
        400
      );
    }

    // If we only received the available-number id, try to fetch its phone_number pre-order.
    if (!e164 && avail_id) {
      const avail = await telnyxGetAvailById({ apiKey: TELNYX_API_KEY, avail_id });
      e164 = toE164(avail?.data?.data?.phone_number || "");
    }

    // 1) Order the number (by id if present, else by e164)
    const order = await telnyxOrder({
      apiKey: TELNYX_API_KEY,
      phone_id: avail_id || null,
      e164: e164 || null,
    });
    if (!order.ok) {
      return json({ error: "telnyx_order_failed", detail: order.data }, 502);
    }

    // Work out the final phone id + number
    let finalPhoneId =
      order.data?.data?.phone_numbers?.[0]?.id || null;
    let finalE164 =
      e164 ||
      order.data?.data?.phone_numbers?.[0]?.phone_number ||
      null;

    // If we still don't have the E.164 (Telnyx sometimes omits it), try the available-number lookup again.
    if (!finalE164 && avail_id) {
      const avail2 = await telnyxGetAvailById({ apiKey: TELNYX_API_KEY, avail_id });
      finalE164 = toE164(avail2?.data?.data?.phone_number || "");
    }

    // If id missing, poll inventory using the number we ordered
    if (!finalPhoneId) {
      if (!finalE164) {
        return json(
          {
            error: "missing_phone_id_after_order",
            detail:
              "Order succeeded but number not returned, and could not infer E.164 for lookup.",
            telnyx_response_snippet: JSON.stringify(order.data).slice(0, 400),
          },
          502
        );
      }
      const looked = await telnyxFindIdByNumber({
        apiKey: TELNYX_API_KEY,
        e164: finalE164,
      });
      if (!looked.id) {
        return json(
          {
            error: "missing_phone_id_after_order",
            detail:
              "Could not resolve phone_number_id after ordering (poll timed out).",
            lookup_for: finalE164,
          },
          502
        );
      }
      finalPhoneId = looked.id;
      finalE164 = finalE164 || looked.phone_number;
    }

    // 2) Assign the messaging profile
    const assign = await telnyxAssignProfile({
      apiKey: TELNYX_API_KEY,
      phone_id: finalPhoneId,
      messaging_profile_id: MESSAGING_PROFILE_ID,
    });
    if (!assign.ok) {
      return json({ error: "telnyx_assign_profile_failed", detail: assign.data }, 502);
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

    return json({
      ok: true,
      id: data?.id || null,
      e164: finalE164,
      telnyx_phone_id: finalPhoneId,
      auth_via: via,
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};