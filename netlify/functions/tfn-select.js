// File: netlify/functions/tfn-select.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function telnyxOrderNumber({ apiKey, phoneId }) {
  // Order the specific available number by ID
  const url = `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phoneId)}/actions/order`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.errors?.[0]?.detail || "telnyx_order_failed");
  return data;
}

async function telnyxAttachMessagingProfile({ apiKey, phoneId, messagingProfileId }) {
  const url = `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(phoneId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.errors?.[0]?.detail || "telnyx_patch_failed");
  return data;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "Method Not Allowed" }, 405);

    const user = await getUserFromRequest(event);
    if (!user?.id) return json({ error: "auth_required" }, 401);

    const API_KEY = process.env.TELNYX_API_KEY;
    if (!API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);

    const body = JSON.parse(event.body || "{}");
    const phone_number = (body.phone_number || "").trim();
    const phone_id = (body.phone_id || "").trim();
    const messaging_profile_id = (body.messaging_profile_id || process.env.TELNYX_MESSAGING_PROFILE_ID || "").trim();

    if (!phone_number || !phone_id) return json({ error: "phone_number and phone_id are required" }, 400);
    if (!messaging_profile_id) return json({ error: "messaging_profile_id missing (body or env)" }, 400);

    // 1) Order the number
    const order = await telnyxOrderNumber({ apiKey: API_KEY, phoneId: phone_id });

    // 2) Attach messaging profile
    await telnyxAttachMessagingProfile({ apiKey: API_KEY, phoneId: phone_id, messagingProfileId: messaging_profile_id });

    // 3) Persist in your DB
    const db = getServiceClient();
    // If number already exists for this user, update; else insert
    const upsert = await db
      .from("agent_messaging_numbers")
      .upsert(
        {
          user_id: user.id,
          e164: phone_number,
          telnyx_phone_id: phone_id,
          telnyx_messaging_profile_id: messaging_profile_id,
          status: "active",
          verified_at: new Date().toISOString(),
        },
        { onConflict: "e164" }
      )
      .select("id, e164, status")
      .maybeSingle();

    if (upsert.error) return json({ error: "db_upsert_failed", detail: upsert.error.message }, 500);

    return json({
      ok: true,
      number: { e164: phone_number, id: phone_id },
      db: upsert.data || null,
      telnyx: { order_id: order?.data?.id || null },
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};