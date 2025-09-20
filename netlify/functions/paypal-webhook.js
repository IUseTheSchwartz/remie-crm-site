// File: netlify/functions/paypal-webhook.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const event = req.body;

    if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
      const resource = event.resource || {};
      const purchase = resource.purchase_units?.[0];
      const refUser = purchase?.reference_id;
      const amount = parseFloat(purchase?.amount?.value || "0");

      if (refUser && amount > 0) {
        const cents = Math.round(amount * 100);
        await supabase.rpc("increment_wallet_balance", {
          uid: refUser,
          delta: cents,
        });
        console.log(`Credited ${cents} to ${refUser}`);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("paypal-webhook error", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
}
