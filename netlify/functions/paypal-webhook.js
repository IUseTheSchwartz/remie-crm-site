// netlify/functions/paypal-webhook.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

// Netlify parses JSON for you if content-type is application/json
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const ev = req.body;

    // We only need to react when an order is CAPTURED (money actually captured)
    // PayPal sends CHECKOUT.ORDER.APPROVED, then CAPTURE after capture() completes.
    const type = ev?.event_type || "";
    const resource = ev?.resource || {};
    const pu0 = resource?.purchase_units?.[0];

    // Handle either event types commonly used:
    // - CHECKOUT.ORDER.APPROVED (amount on purchase_unit.amount)
    // - PAYMENT.CAPTURE.COMPLETED (amount on resource.amount)
    let refUser = pu0?.reference_id || resource?.supplementary_data?.related_ids?.order_id; // prefer reference_id
    let amountValue =
      pu0?.amount?.value ??
      resource?.amount?.value ??
      resource?.seller_receivable_breakdown?.gross_amount?.value;

    if (!refUser || !amountValue) {
      console.log("Webhook missing refUser/amount, ignoring.", { type, refUser, amountValue });
      return res.status(200).json({ ok: true });
    }

    const cents = Math.round(parseFloat(amountValue) * 100);
    if (!(cents > 0)) return res.status(200).json({ ok: true });

    // Credit wallet atomically via RPC
    const { error } = await supabase.rpc("increment_wallet_balance", {
      uid: refUser,
      delta_cents: cents,
    });
    if (error) {
      console.error("Supabase RPC error:", error);
      return res.status(500).json({ error: "Supabase RPC failed" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("paypal-webhook error", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
}
