// File: netlify/functions/create-team.js
import { supaAdmin, getUserIdFromEvent, ensureStripeCustomerForUser, stripe } from "./_shared.js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const { name } = JSON.parse(event.body || "{}");
    if (!name) return { statusCode: 400, body: "Missing name" };

    const supa = supaAdmin();
    const userId = getUserIdFromEvent(event);

    // Ensure Stripe customer for owner (also updates profiles.stripe_customer_id)
    const customerId = await ensureStripeCustomerForUser(supa, userId);

    // Create subscription with seat price at quantity 0, attach metadata for your webhook.
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_SEAT_50, quantity: 0 }],
      payment_behavior: "default_incomplete",
      collection_method: "charge_automatically",
      metadata: { app_user_id: userId }, // your webhook reads this
      expand: ["latest_invoice.payment_intent"],
    });

    // Create team + set owner membership
    const { data: team, error: teamErr } = await supa
      .from("teams")
      .insert({
        owner_id: userId,
        name,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
      })
      .select("*")
      .single();

    if (teamErr) throw teamErr;

    const { error: memberErr } = await supa
      .from("user_teams")
      .insert({ user_id: userId, team_id: team.id, role: "owner", status: "active" });
    if (memberErr) throw memberErr;

    return {
      statusCode: 200,
      body: JSON.stringify({ team, subscriptionClientSecret: subscription.latest_invoice?.payment_intent?.client_secret || null }),
    };
  } catch (e) {
    console.error("create-team error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
