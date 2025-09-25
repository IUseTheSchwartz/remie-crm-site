// netlify/functions/purchase-number.js
// Charges 500 cents ($5) from CRM wallet (first number free), orders Telnyx DID,
// assigns to your Call Control app, and inserts into agent_numbers.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const PRICE_CENTS = 500; // $5.00

// Env
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID; // "cc-…"
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || null;     // optional fallback
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function bad(status, error, extra = {}) {
  return { statusCode: status, body: JSON.stringify({ ok: false, error, ...extra }) };
}
function isE164(n) { return /^\+\d{8,15}$/.test(String(n || "").trim()); }
function idem() { return "purchase-" + Math.random().toString(36).slice(2); }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // Env checks
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY is not set");
  if (!SUPABASE_URL) return bad(500, "SUPABASE_URL is not set");
  if (!SUPABASE_SERVICE_ROLE_KEY) return bad(500, "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE) is not set");
  if (!TELNYX_CALL_CONTROL_APP_ID && !TELNYX_CONNECTION_ID) {
    return bad(500, "Provide TELNYX_CALL_CONTROL_APP_ID (preferred) or TELNYX_CONNECTION_ID");
  }

  // Parse body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON body"); }
  const phone_number = (body.phone_number || "").trim();
  const agent_id = (body.agent_id || "").trim();
  const client_txn_id = (body.client_txn_id || idem()).trim();
  if (!isE164(phone_number)) return bad(422, "phone_number must be E.164 (e.g. +16155551234)");
  if (!agent_id) return bad(422, "agent_id required");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // A) First number free?
    const { count, error: countErr } = await supabase
      .from("agent_numbers")
      .select("*", { head: true, count: "exact" })
      .eq("agent_id", agent_id);
    if (countErr) return bad(500, "DB error (count): " + countErr.message);

    const firstFree = (count || 0) === 0;
    const priceCents = firstFree ? 0 : PRICE_CENTS;

    // B) If not free, atomic debit via RPC
    if (priceCents > 0) {
      const { data: debitRes, error: debitErr } = await supabase.rpc("debit_cents", {
        p_user: agent_id,
        p_amount: priceCents,
      });
      if (debitErr) return bad(500, "Wallet error: " + debitErr.message);
      const ok = debitRes && debitRes[0] && debitRes[0].ok === true;
      if (!ok) {
        const bal = debitRes && debitRes[0] ? debitRes[0].balance : null;
        return bad(402, "INSUFFICIENT_FUNDS", { balance_cents: bal, required_cents: priceCents });
      }
    }

    // C) Order number at Telnyx (idempotent)
    const orderPayload = { phone_numbers: [{ phone_number }] };
    if (TELNYX_CONNECTION_ID) orderPayload.connection_id = String(TELNYX_CONNECTION_ID);

    const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": client_txn_id,
      },
      body: JSON.stringify(orderPayload),
    });
    const orderJson = await orderRes.json();

    if (!orderRes.ok) {
      // Refund if we charged
      if (priceCents > 0) {
        await supabase.rpc("credit_cents", { p_user: agent_id, p_amount: priceCents });
      }
      const detail = orderJson?.errors?.[0]?.detail || orderJson?.error || JSON.stringify(orderJson);
      return bad(orderRes.status, `Telnyx order failed: ${detail}`, { telnyx_status: orderRes.status });
    }

    const purchasedNumber =
      orderJson?.data?.phone_numbers?.[0]?.phone_number || phone_number;

    // D) Assign to your Call Control app (preferred)
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
        try { console.warn("Assign warning:", await assignRes.json()); } catch {}
      }
    }

    // E) Save in DB so UI shows it
    const { error: insErr } = await supabase.from("agent_numbers").insert({
      agent_id,
      telnyx_number: purchasedNumber,
      is_free: firstFree,
    });
    if (insErr) {
      // Don't refund here—you already own the number; just report
      return bad(200, "Purchased but failed to save in DB: " + insErr.message, { purchasedNumber });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        phone_number: purchasedNumber,
        charged_cents: priceCents,
        firstNumberFree: firstFree,
      }),
    };
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
