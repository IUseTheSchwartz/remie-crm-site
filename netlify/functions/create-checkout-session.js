// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body = JSON.parse(event.body || "{}");
    const {
      priceId,
      userId,
      email,
      successUrl,
      cancelUrl,
      trial,          // boolean
      trialDays,      // optional, prefer 7 if provided/undefined
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
    const subData = {
      metadata: { app_user_id: userId },
    };
    if (trial === true) {
      subData.trial_period_days = Number.isFinite(trialDays) ? Number(trialDays) : 7; // ✅ enforce 7 by default
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url:
        successUrl || (process.env.SITE_URL || "https://example.com") + "/app/settings",
      cancel_url:
        cancelUrl || (process.env.SITE_URL || "https://example.com") + "/",
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
    return { statusCode: 500, body: e.message || "Server error" };
  }
}
