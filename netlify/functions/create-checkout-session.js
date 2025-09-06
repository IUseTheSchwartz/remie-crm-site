// File: netlify/functions/create-checkout-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function supaAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}
function appBase() {
  return process.env.PUBLIC_APP_URL || "http://localhost:8888";
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const { priceId, email, userId } = JSON.parse(event.body || "{}");
    if (!userId) return { statusCode: 400, body: "Missing userId" };
    if (!priceId) return { statusCode: 400, body: "Missing priceId" };

    const supa = supaAdmin();

    // 1) Find or create Stripe customer and ensure metadata.user_id is set
    let customer = null;
    if (email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      if (list?.data?.length) customer = list.data[0];
    }
    if (!customer) {
      customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { user_id: userId },
      });
    } else if ((customer.metadata?.user_id || "") !== userId) {
      await stripe.customers.update(customer.id, {
        metadata: { ...(customer.metadata || {}), user_id: userId },
      });
    }

    // 2) Upsert durable mapping user_id <-> stripe_customer_id
    await supa
      .from("user_stripe_customers")
      .upsert({ user_id: userId, stripe_customer_id: customer.id });

    // 3) Create subscription checkout with app_user_id in metadata
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { app_user_id: userId },
      subscription_data: { metadata: { app_user_id: userId } },
      success_url: `${appBase()}/app?billing=success`,
      cancel_url: `${appBase()}/app?billing=cancelled`,
      allow_promotion_codes: true,
    });

    return { statusCode: 200, body: JSON.stringify({ id: session.id, url: session.url }) };
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
