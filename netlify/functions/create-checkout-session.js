// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body = JSON.parse(event.body || "{}");

    // === Balance top-up flow (wallet funding) ===
    if (body.amount_cents && body.user_id) {
      const amount = body.amount_cents;
      const userId = body.user_id;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "SMS Credits" },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          metadata: { app_user_id: userId, purpose: "wallet_topup" },
        },
        success_url:
          (process.env.SITE_URL || "https://example.com") + "/app/messaging-settings",
        cancel_url:
          (process.env.SITE_URL || "https://example.com") + "/app/messaging-settings",
        metadata: { app_user_id: userId, purpose: "wallet_topup" },
      });

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: session.url }),
      };
    }

    // === Subscription flow (your original code) ===
    const {
      priceId,
      userId,
      email,
      successUrl,
      cancelUrl,
      trial = false,
    } = body;

    if (!priceId || !email || !userId) {
      return { statusCode: 400, body: "Missing priceId, email, or userId" };
    }

    const customers = await stripe.customers.list({ email, limit: 1 });
    const existing = customers.data?.[0];

    const customer = existing
      ? await stripe.customers.update(existing.id, { metadata: { user_id: userId } })
      : await stripe.customers.create({ email, metadata: { user_id: userId } });

    const TRIAL_DAYS = 14;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      payment_method_collection: trial ? "if_required" : "always",
      subscription_data: trial
        ? {
            trial_period_days: TRIAL_DAYS,
            trial_settings: {
              end_behavior: { missing_payment_method: "pause" },
            },
            metadata: { app_user_id: userId },
          }
        : { metadata: { app_user_id: userId } },
      success_url:
        successUrl ||
        (process.env.SITE_URL || "https://example.com") + "/app/settings",
      cancel_url:
        cancelUrl || (process.env.SITE_URL || "https://example.com") + "/",
      metadata: {
        app_user_id: userId,
        started_with_trial: trial ? "true" : "false",
      },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || "Server error" };
  }
}
