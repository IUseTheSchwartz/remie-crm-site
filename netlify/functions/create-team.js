// netlify/functions/create-team.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const REQUIRED_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_SEAT_50",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE", // or SUPABASE_SERVICE_ROLE_KEY
];

function assertEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`[ENV] Missing: ${missing.join(", ")}`);
}

function supaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

const ACTIVE_SET = new Set(["active", "trialing"]);

async function hasPersonalSubscription(supa, userId) {
  // Primary path: direct user_id match
  const { data: directRows, error: directErr } = await supa
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .order("current_period_end", { ascending: false, nullsLast: true })
    .limit(1);

  if (!directErr && Array.isArray(directRows) && directRows.length) {
    const status = (directRows[0].status || "").toLowerCase().trim();
    if (ACTIVE_SET.has(status)) return true;
  }

  // Fallback: if user_id wasn’t backfilled yet, look up the customer mapping and check by stripe_customer_id
  const { data: map, error: mapErr } = await supa
    .from("user_stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!mapErr && map?.stripe_customer_id) {
    const { data: byCus, error: byCusErr } = await supa
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("stripe_customer_id", map.stripe_customer_id)
      .order("current_period_end", { ascending: false, nullsLast: true })
      .limit(1);

    if (!byCusErr && Array.isArray(byCus) && byCus.length) {
      const status = (byCus[0].status || "").toLowerCase().trim();
      if (ACTIVE_SET.has(status)) return true;
    }
  }

  return false;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST")
      return { statusCode: 405, body: "Method not allowed" };

    assertEnv();

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supa = supaAdmin();

    // --- Auth from frontend header ---
    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    // --- Parse body ---
    let name = "";
    try {
      const body = JSON.parse(event.body || "{}");
      name = (body.name || "").trim();
    } catch {}
    if (!name) return { statusCode: 400, body: "Missing team name" };

    // --- Require PERSONAL subscription (seats can use CRM but not create teams) ---
    const ok = await hasPersonalSubscription(supa, userId);
    if (!ok) {
      // Keep a structured error so the client can show a friendly CTA
      return { statusCode: 403, body: JSON.stringify({ error: "needs_subscription" }) };
    }

    // --- Get or create a Stripe customer for this owner (optional but nice to have) ---
    let stripeCustomerId = null;
    // If you have a profiles table, you can read a stored customer id (optional)
    try {
      const { data: map } = await supa
        .from("user_stripe_customers")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (map?.stripe_customer_id) {
        stripeCustomerId = map.stripe_customer_id;
      }
    } catch {}

    if (!stripeCustomerId) {
      // As a fallback, try to pull email from auth.users and create the customer
      let email = null;
      try {
        const { data: authUser } = await supa.auth.admin.getUserById(userId);
        email = authUser?.user?.email || null;
      } catch {}

      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { user_id: userId },
      });
      stripeCustomerId = customer.id;

      // Store mapping for future lookups
      try {
        await supa
          .from("user_stripe_customers")
          .upsert({ user_id: userId, stripe_customer_id: stripeCustomerId });
      } catch {}
    }

    // --- Create the team's seats subscription (qty 0; owner not counted as a seat) ---
    let subscription;
    try {
      subscription = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [{ price: process.env.STRIPE_PRICE_SEAT_50, quantity: 0 }],
        payment_behavior: "default_incomplete",
        collection_method: "charge_automatically",
        metadata: { app_user_id: userId },
        expand: ["latest_invoice.payment_intent"],
      });
    } catch (e) {
      console.error("[create-team] Stripe subscription error:", e?.message || e);
      return {
        statusCode: 400,
        body: `Stripe error: ${e?.message || "create subscription failed"}`,
      };
    }

    // --- Create team row ---
    let team;
    try {
      const { data, error } = await supa
        .from("teams")
        .insert({
          owner_id: userId,
          name,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: subscription.id,
        })
        .select("*")
        .single();
      if (error) throw error;
      team = data;
    } catch (e) {
      console.error("[create-team] Supabase insert teams failed:", e?.message || e);
      return { statusCode: 500, body: "Failed to create team record" };
    }

    // --- Add owner membership ---
    try {
      const { error } = await supa
        .from("user_teams")
        .insert({ user_id: userId, team_id: team.id, role: "owner", status: "active" });
      if (error) throw error;
    } catch (e) {
      console.error("[create-team] Supabase insert user_teams failed:", e?.message || e);
      return { statusCode: 500, body: "Failed to join team as owner" };
    }

    const clientSecret =
      subscription?.latest_invoice?.payment_intent?.client_secret || null;

    return {
      statusCode: 200,
      body: JSON.stringify({ team, subscriptionClientSecret: clientSecret }),
    };
  } catch (e) {
    console.error("[create-team] Uncaught error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}