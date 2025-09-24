// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/**
 * Optional env (for wallet gross-up + UX)
 *  - SITE_URL
 *  - TOPUP_MIN_CENTS (default 1000 = $10)
 *  - FEE_PERCENT (e.g., 0.039 for ~3.9%)
 *  - FEE_FIXED_CENTS (e.g., 30 for $0.30)
 */

function grossUpCents(netCents, percent = 0, fixedCents = 0) {
  const denom = 1 - (percent || 0);
  return Math.ceil((Number(netCents) + (fixedCents || 0)) / (denom > 0 ? denom : 1));
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");

    // ---- Branch A: Wallet top-up via Stripe (one-time payment) ----
    // Triggered when client includes `walletTopUp: true` (or provides `netTopUpCents`)
    if (body.walletTopUp === true || Number.isFinite(Number(body.netTopUpCents))) {
      const {
        userId,                 // required
        netTopUpCents,          // required: how many cents to CREDIT as wallet balance
        coverFees = true,       // if true, we gross-up the charge so user nets the above
        clientRef,              // optional idempotency key
        successUrl,
        cancelUrl,
      } = body;

      if (!userId || !Number.isFinite(Number(netTopUpCents))) {
        return { statusCode: 400, body: "userId and netTopUpCents required" };
      }

      const min = Number(process.env.TOPUP_MIN_CENTS || 1000); // default $10
      if (Number(netTopUpCents) < min) {
        return { statusCode: 400, body: `Minimum top-up is ${min} cents` };
      }

      const pct = Number(process.env.FEE_PERCENT || 0);
      const fixed = Number(process.env.FEE_FIXED_CENTS || 0);
      const amountToChargeCents = coverFees
        ? grossUpCents(Number(netTopUpCents), pct, fixed)
        : Number(netTopUpCents);

      const site = process.env.SITE_URL || `https://${event.headers.host}`;
      const success = (successUrl || site) + "/app/wallet?success=1";
      const cancel = (cancelUrl || site) + "/app/wallet?canceled=1";

      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: "Texting Wallet Top-up" },
                unit_amount: amountToChargeCents,
              },
              quantity: 1,
            },
          ],
          success_url: success,
          cancel_url: cancel,
          metadata: {
            user_id: userId,
            net_topup_cents: String(netTopUpCents),
            cover_fees: String(!!coverFees),
          },
        },
        clientRef ? { idempotencyKey: `checkout_${clientRef}` } : undefined
      );

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: session.url }),
      };
    }

    // ---- Branch B: Subscriptions (your original behavior) ----
    const {
      priceId,
      userId,
      email,
      successUrl,
      cancelUrl,
      trial,          // boolean
      trialDays,      // optional, defaults to 7 if trial===true
    } = body;

    if (!priceId || !email || !userId) {
      return { statusCode: 400, body: "Missing priceId, email, or userId" };
    }

    // Find or create customer by email; stamp metadata.user_id
    const customers = await stripe.customers.list({ email, limit: 1 });
    const existing = customers.data?.[0];
    const customer = existing
      ? await stripe.customers.update(existing.id, { metadata: { user_id: userId } })
      : await stripe.customers.create({ email, metadata: { user_id: userId } });

    // Build subscription_data; include trial only when requested
    const subData = { metadata: { app_user_id: userId } };
    if (trial === true) {
      subData.trial_period_days = Number.isFinite(trialDays) ? Number(trialDays) : 7;
    }

    const site = process.env.SITE_URL || "https://example.com";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${site}/app/settings`,
      cancel_url: cancelUrl || `${site}/`,
      allow_promotion_codes: true,
      subscription_data: subData,
      metadata: { app_user_id: userId },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (e) {
    console.error("[create-checkout-session] error:", e);
    return { statusCode: 500, body: e.message || "Server error" };
  }
}
