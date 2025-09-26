// /.netlify/functions/tfn-select.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;

function json(body, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function toE164(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "Method Not Allowed" }, 405);
    if (!TELNYX_API_KEY || !MESSAGING_PROFILE_ID) {
      return json({ error: "Missing TELNYX_API_KEY or TELNYX_MESSAGING_PROFILE_ID" }, 500);
    }

    const db = getServiceClient();

    let userId = event.headers["x-user-id"] || null;
    if (!userId) {
      const u = await getUserFromRequest(event);
      userId = u?.id || null;
    }
    if (!userId) return json({ error: "unauthorized" }, 401);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const wanted = toE164(body?.phone_number || body?.number);
    if (!wanted) return json({ error: "invalid_number" }, 400);

    // Quick existence check to avoid duplicate purchases
    const { data: exists } = await db
      .from("agent_numbers")
      .select("id")
      .eq("e164", wanted)
      .maybeSingle();
    if (exists) return json({ error: "already_taken" }, 409);

    // 1) Order the number
    const orderRes = await fetch("https://api.telnyx.com/v2/phone_numbers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_numbers: [{ phone_number: wanted }] }),
    });
    const ordered = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) {
      const msg = ordered?.errors?.[0]?.detail || JSON.stringify(ordered);
      return json({ error: "telnyx_order_failed", detail: msg }, orderRes.status);
    }
    const phone = ordered?.data?.[0];
    if (!phone?.id || !phone?.phone_number) {
      return json({ error: "telnyx_order_invalid_response" }, 502);
    }

    // 2) Attach to your verified Messaging Profile (inherits verification)
    const attachRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${phone.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_profile_id: MESSAGING_PROFILE_ID }),
    });
    const attached = await attachRes.json().catch(() => ({}));
    if (!attachRes.ok) {
      const msg = attached?.errors?.[0]?.detail || JSON.stringify(attached);
      return json({ error: "telnyx_attach_failed", detail: msg }, attachRes.status);
    }

    // 3) Persist ownership in agent_numbers (status active)
    const ins = await db
      .from("agent_numbers")
      .insert({
        user_id: userId,
        e164: phone.phone_number,
        telnyx_phone_id: phone.id,
        telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
        status: "active",
        verified_at: new Date().toISOString(),
      })
      .select("id, e164")
      .maybeSingle();

    if (ins?.error) {
      // Attempt cleanup: release the number to avoid orphaned spend
      try {
        await fetch(`https://api.telnyx.com/v2/phone_numbers/${phone.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
        });
      } catch {}
      return json({ error: "db_insert_failed", detail: ins.error.message }, 500);
    }

    return json({ ok: true, number: ins?.data?.e164 || phone.phone_number });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};
