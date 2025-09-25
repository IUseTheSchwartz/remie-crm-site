// netlify/functions/telnyx-order-number.js
// Purchases a Telnyx DID, assigns it to your Call Control/Voice app, and saves to agent_numbers.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

/* ---------- ENV (supports both SERVICE_ROLE var names) ---------- */
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID; // "cc-…"
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || null;     // optional

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

/* ---------- helpers ---------- */
function bad(status, error, extra = {}) {
  return { statusCode: status, body: JSON.stringify({ ok: false, error, ...extra }) };
}
function isE164(n) {
  return /^\+\d{8,15}$/.test(String(n || "").trim());
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // Explicit, helpful env checks
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY is not set");
  if (!SUPABASE_URL) return bad(500, "SUPABASE_URL is not set");
  if (!SUPABASE_SERVICE_ROLE_KEY)
    return bad(500, "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE) is not set");
  // For assignment we need either the Call Control App ID or a Connection ID
  if (!TELNYX_CALL_CONTROL_APP_ID && !TELNYX_CONNECTION_ID) {
    return bad(500, "Provide TELNYX_CALL_CONTROL_APP_ID (preferred) or TELNYX_CONNECTION_ID");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Parse input
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "Invalid JSON body"); }

  const phone_number = (body.phone_number || "").trim();
  const agent_id = (body.agent_id || "").trim();
  const is_free = !!body.is_free;

  if (!isE164(phone_number)) return bad(422, "phone_number must be E.164 (e.g. +16155551234)");
  if (!agent_id) return bad(422, "agent_id required");

  try {
    /* 1) Create number order (purchase) */
    // You *can* include connection_id in the order; we still run an explicit assign step after.
    const orderPayload = {
      phone_numbers: [{ phone_number }],
    };
    if (TELNYX_CONNECTION_ID) {
      orderPayload.connection_id = String(TELNYX_CONNECTION_ID);
    }

    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });
    const orderJson = await orderRes.json();

    if (!orderRes.ok) {
      const detail =
        orderJson?.errors?.[0]?.detail ||
        orderJson?.error ||
        JSON.stringify(orderJson);
      return bad(orderRes.status, `Telnyx order failed: ${detail}`, { telnyx_status: orderRes.status });
    }

    const purchasedNumber =
      orderJson?.data?.phone_numbers?.[0]?.phone_number || phone_number;

    /* 2) Ensure assignment to your Voice/Call Control app */
    // Preferred: explicit "assign" with call_control_app_id
    if (TELNYX_CALL_CONTROL_APP_ID) {
      const assignRes = await fetch("https://api.telnyx.com/v2/phone_numbers/assign", {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_numbers: [{ phone_number: purchasedNumber }],
          connection: { call_control_app_id: TELNYX_CALL_CONTROL_APP_ID },
        }),
      });
      if (!assignRes.ok) {
        // If already assigned, Telnyx may 4xx with a descriptive message — don't hard-fail purchase
        try { console.warn("Assign warning:", await assignRes.json()); } catch {}
      }
    } else if (TELNYX_CONNECTION_ID) {
      // Fallback: patch voice settings via connection_id
      const idRes = await fetch(
        `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(purchasedNumber)}`,
        { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
      );
      const idJson = await idRes.json();
      const phoneId = idJson?.data?.[0]?.id;

      if (phoneId) {
        const voiceRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${phoneId}/voice`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: String(TELNYX_CONNECTION_ID) }),
        });
        if (!voiceRes.ok) {
          try { console.warn("Voice assign warning:", await voiceRes.json()); } catch {}
        }
      }
    }

    /* 3) Save to DB so your app shows it immediately */
    const { error: dbErr } = await supabase.from("agent_numbers").insert({
      agent_id,
      telnyx_number: purchasedNumber,
      is_free,
    });
    if (dbErr) {
      return bad(200, `Purchased but failed to save in DB: ${dbErr.message}`, { purchasedNumber });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, phone_number: purchasedNumber }),
    };
  } catch (e) {
    return bad(500, e?.message || "Unexpected error while purchasing");
  }
};
