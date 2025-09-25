// netlify/functions/telnyx-order-number.js
// Purchases a Telnyx DID, assigns it to your Call Control/Voice app, and saves to agent_numbers.

const fetch = require("node-fetch");

// If you're using Supabase: install supabase-js on functions and set env vars
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
// Prefer explicit connection_id for numbers; works for Call Control/Voice apps too.
const TELNYX_CONNECTION_ID =
  process.env.TELNYX_CONNECTION_ID || process.env.TELNYX_CALL_CONTROL_APP_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    body: JSON.stringify({ ok: false, error, ...extra }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return bad(405, "Method Not Allowed");
  }

  // --- Parse input
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "Invalid JSON body");
  }
  const phone_number = (body.phone_number || "").trim();
  const agent_id = (body.agent_id || "").trim();
  const is_free = !!body.is_free;

  if (!phone_number || !/^\+\d{8,15}$/.test(phone_number)) {
    return bad(422, "phone_number must be E.164 (e.g. +16155551234)");
  }
  if (!agent_id) return bad(422, "agent_id required");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY is not set in env");
  if (!TELNYX_CONNECTION_ID) {
    return bad(
      500,
      "Missing TELNYX_CONNECTION_ID (or TELNYX_CALL_CONTROL_APP_ID) env var"
    );
  }
  if (!supabase) {
    return bad(500, "Supabase server credentials are not configured");
  }

  try {
    // --- 1) Create Number Order (purchases the DID)
    // You can include connection_id *in the order* so the number is assigned on purchase.
    // https://developers.telnyx.com/api/numbers/create-number-order  (Number Orders quickstart: order then list)
    // Request schema includes connection_id: https://preview.redoc.ly/... Number-Orders-API (shows connection_id in request/response)
    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        connection_id: String(TELNYX_CONNECTION_ID),
        phone_numbers: [{ phone_number }],
      }),
    });

    const orderJson = await orderRes.json();
    if (!orderRes.ok) {
      const detail =
        orderJson?.errors?.[0]?.detail ||
        orderJson?.error ||
        JSON.stringify(orderJson);
      return bad(orderRes.status, `Telnyx order failed: ${detail}`, {
        telnyx_status: orderRes.status,
      });
    }

    // Order response includes the purchased numbers + status
    // Example in docs shows "status":"success" when complete. If pending, you could poll — usually it's instant for US/CA locals.
    const purchased = orderJson?.data?.phone_numbers?.[0];
    const purchasedNumber = purchased?.phone_number || phone_number;

    // --- 2) (Safety) Ensure voice settings point to your app/connection
    // If your account returns an order without assignment, force assign via voice settings:
    // PATCH /v2/phone_numbers/:id/voice with { connection_id }
    // https://developers.telnyx.com/api/numbers/update-phone-number-voice-settings
    const idRes = await fetch(
      `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(
        purchasedNumber
      )}`,
      { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
    );
    const idJson = await idRes.json();
    const phoneObj = idJson?.data?.[0];
    const phoneId = phoneObj?.id;

    if (phoneId) {
      const voiceRes = await fetch(
        `https://api.telnyx.com/v2/phone_numbers/${phoneId}/voice`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TELNYX_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ connection_id: String(TELNYX_CONNECTION_ID) }),
        }
      );
      if (!voiceRes.ok) {
        const voiceJson = await voiceRes.json().catch(() => ({}));
        // Don't hard-fail on this—your number may already be assigned from the order step.
        console.warn("Voice assignment warning:", voiceJson);
      }
    }

    // --- 3) Insert into agent_numbers so your app sees it
    const { error: dbErr } = await supabase.from("agent_numbers").insert({
      agent_id,
      telnyx_number: purchasedNumber,
      is_free,
    });
    if (dbErr) {
      // You *did* buy the number at this point. Return 200 but surface DB insert issue.
      return bad(200, `Purchased but failed to save in DB: ${dbErr.message}`, {
        purchasedNumber: purchasedNumber,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, phone_number: purchasedNumber }),
    };
  } catch (e) {
    return bad(500, e?.message || "Unexpected error while purchasing");
  }
};
