// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Added: optional `trial` flag; everything else stays as you had it
    const {
      priceId,
      userId,
      email,
      successUrl,
      cancelUrl,
      trial = false, // <— new
    } = JSON.parse(event.body || "{}");

    if (!priceId || !email || !userId) {
      return { statusCode: 400, body: "Missing priceId, email, or userId" };
    }

    // Reuse/create customer (unchanged), keep user_id in metadata
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

      // Only collect a card up front if needed when starting a trial.
      // (Stripe may still require it based on settings/risk.)
      payment_method_collection: trial ? "if_required" : "always",

      // Added: trial configuration (only when trial=true)
      subscription_data: trial
        ? {
            trial_period_days: TRIAL_DAYS,
            trial_settings: {
              end_behavior: {
                // If no card added by trial end:
                // choose "pause" (keeps sub paused) or "cancel"
                missing_payment_method: "pause",
              },
            },
            metadata: { app_user_id: userId },
          }
        : {
            metadata: { app_user_id: userId },
          },

      // Keep your existing default redirects
      success_url:
        successUrl ||
        (process.env.SITE_URL || "https://example.com") + "/app/settings",
      cancel_url:
        cancelUrl || (process.env.SITE_URL || "https://example.com") + "/",

      // Tag the session itself so webhooks/analytics can see it started as a trial
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
    return { statusCode: 500, body: e.message || "Server error" };
  }
}
