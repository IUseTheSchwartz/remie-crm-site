// File: netlify/functions/_shared.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export function supaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.SUPABASE_URL || !key) throw new Error("Supabase env missing");
  return createClient(process.env.SUPABASE_URL, key);
}

// Extract authenticated user id (adjust to your auth approach)
export function getUserIdFromEvent(event) {
  // If you’re using Supabase Auth JWT in Authorization header:
  // In many setups you’ll pass the user id from the client as X-User-Id (since this is a trusted function behind RLS service role).
  // Choose ONE approach and keep it consistent.
  const uid = event.headers["x-user-id"]; // simple, explicit header
  if (!uid) throw new Error("Missing X-User-Id");
  return uid;
}

export async function ensureStripeCustomerForUser(supa, userId) {
  const { data: profile } = await supa
    .from("profiles")
    .select("id, stripe_customer_id, email")
    .eq("id", userId)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id || null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile?.email || undefined,
      metadata: { user_id: userId }, // your webhook reads this fallback
    });
    customerId = customer.id;

    await supa
      .from("profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", userId);
  }
  return customerId;
}

export async function syncStripeSeatsForTeam(supa, teamId) {
  // get current seats
  const { data: seatRow, error: seatErr } = await supa
    .from("team_active_seats")
    .select("*")
    .eq("team_id", teamId)
    .single();
  if (seatErr) throw seatErr;
  const quantity = seatRow?.active_seats || 0;

  const { data: team, error: teamErr } = await supa
    .from("teams")
    .select("stripe_subscription_id")
    .eq("id", teamId)
    .single();
  if (teamErr) throw teamErr;

  if (!team?.stripe_subscription_id) return;

  // Update the *subscription item* quantity.
  // Easiest path: a single-seat price is the only item on this sub.
  const sub = await stripe.subscriptions.retrieve(team.stripe_subscription_id, {
    expand: ["items.data.price"],
  });

  const seatItem = sub.items.data.find(
    (it) => it.price.id === process.env.STRIPE_PRICE_SEAT_50
  );
  if (!seatItem) {
    // If the subscription was created without an item (or item missing), add it.
    await stripe.subscriptions.update(team.stripe_subscription_id, {
      items: [{ price: process.env.STRIPE_PRICE_SEAT_50, quantity }],
      proration_behavior: "always_invoice",
    });
  } else {
    await stripe.subscriptionItems.update(seatItem.id, {
      quantity,
      proration_behavior: "always_invoice",
    });
  }
}
