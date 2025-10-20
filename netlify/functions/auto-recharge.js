// File: netlify/functions/auto-recharge.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.handler = async () => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE
  );

  try {
    const { data: subs, error } = await supabase
      .from("subscriptions")
      .select("user_id, stripe_customer_id, saved_payment_method, auto_recharge_enabled, auto_recharge_threshold_cents, auto_recharge_amount_cents")
      .eq("auto_recharge_enabled", true);

    if (error) throw error;
    if (!subs?.length) return { statusCode: 200, body: "No active auto-recharges" };

    for (const sub of subs) {
      const { user_id, stripe_customer_id, saved_payment_method, auto_recharge_threshold_cents, auto_recharge_amount_cents } = sub;

      if (!stripe_customer_id || !saved_payment_method) continue;

      // Get current wallet balance
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", user_id)
        .maybeSingle();
      const balance = wallet?.balance_cents || 0;

      if (balance >= auto_recharge_threshold_cents) continue;

      // Charge card
      const amountCents = auto_recharge_amount_cents || 1000;
      const payment = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        customer: stripe_customer_id,
        payment_method: saved_payment_method,
        off_session: true,
        confirm: true,
        description: "Auto wallet recharge",
      });

      if (payment.status === "succeeded") {
        await supabase.rpc("incr_text_balance", {
          p_user_id: user_id,
          p_delta_cents: amountCents,
        });

        await supabase.from("wallet_transactions").insert({
          user_id,
          type: "credit",
          amount_cents: amountCents,
          description: "Auto-recharge",
          stripe_event_id: payment.id,
        });
      }
    }

    return { statusCode: 200, body: "Auto-recharge processed" };
  } catch (e) {
    console.error("auto-recharge error:", e);
    return { statusCode: 500, body: e.message };
  }
};
