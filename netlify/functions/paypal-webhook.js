// netlify/functions/paypal-webhook.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const ev = JSON.parse(event.body || "{}");
    const resource = ev?.resource || {};
    const pu0 = resource?.purchase_units?.[0];

    // You set this when creating the order
    const refUser = pu0?.reference_id;
    const amountValue =
      pu0?.amount?.value ??
      resource?.amount?.value ??
      resource?.seller_receivable_breakdown?.gross_amount?.value;

    if (!refUser || !amountValue) {
      console.log("Webhook missing refUser/amount; skipping.", { event_type: ev?.event_type });
      return json(200, { ok: true });
    }

    const cents = Math.round(parseFloat(amountValue) * 100);
    if (!(cents > 0)) return json(200, { ok: true });

    const { error } = await supabase.rpc("increment_wallet_balance", {
      uid: refUser,
      delta_cents: cents,
    });
    if (error) {
      console.error("Supabase RPC error:", error);
      return json(500, { error: "Supabase RPC failed" });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error("paypal-webhook error", err);
    return json(500, { error: "Webhook failed" });
  }
};
