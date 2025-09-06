// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function supaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

function appBase() {
  return process.env.PUBLIC_APP_URL || "http://localhost:8888";
}

// ENV you should have set:
// - STRIPE_PRICE_CRM_MONTHLY (your $280 plan)  OR whichever price you use for your CRM
// - PUBLIC_APP_URL (optional, for success/cancel urls)

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const { priceId, email, userId } = JSON.parse(event.body || "{}");
    if (!userId) return { statusCode: 400, body: "Missing userId" };
    if (!priceId) return { statusCode: 400, body: "Missing priceId" };

    const supa = supaAdmin();

    // 1) Find or create Stripe Customer by email, and stamp user id metadata
    //    (If you already store stripe_customer_id somewhere, you could reuse it here.)
    //    We’ll search by email first (Stripe API doesn’t have a direct lookup; this is list+filter).
    let customer = null;

    if (email) {
      const found = await stripe.customers.list({ email, limit: 1 });
      if (found?.data?.length) customer = found.data[0];
    }

    if (!customer) {
      customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { user_id: userId }, // critical for webhook mapping fallback
      });
    } else {
      // ensure metadata.user_id is set (don’t overwrite other keys)
      if (!customer.metadata || customer.metadata.user_id !== userId) {
        await stripe.customers.update(customer.id, {
          metadata: { ...(customer.metadata || {}), user_id: userId },
        });
      }
    }

    // 2) Create Checkout Session for a subscription
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      // Critical: repeat app_user_id in both places to help the webhook
      metadata: { app_user_id: userId },
      subscription_data: {
        metadata: { app_user_id: userId },
      },
      success_url: `${appBase()}/app?billing=success`,
      cancel_url: `${appBase()}/app?billing=cancelled`,
      allow_promotion_codes: true,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ id: session.id, url: session.url }),
    };
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
