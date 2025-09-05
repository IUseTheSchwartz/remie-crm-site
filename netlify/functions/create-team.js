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
  if (missing.length) {
    throw new Error(`[ENV] Missing: ${missing.join(", ")}`);
  }
}

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST")
      return { statusCode: 405, body: "Method not allowed" };

    assertEnv();

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supa = makeSupaAdmin();

    // ---- Auth ----
    const userId = event.headers["x-user-id"];
    if (!userId) {
      console.error("[create-team] Missing X-User-Id header");
      return { statusCode: 401, body: "Not authenticated" };
    }

    // ---- PLAN GATE: user must have their OWN CRM subscription ----
    // Allowed statuses for *personal* plan (NOT team membership)
    const OK = new Set(["active", "trialing"]);
    let planStatus = null;
    let userEmail = null;
    let stripeCustomerId = null;

    try {
      const { data: prof } = await supa
        .from("profiles")
        .select("id, email, plan_status, stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();
      planStatus = (prof?.plan_status || "").toLowerCase();
      userEmail = prof?.email || null;
      stripeCustomerId = prof?.stripe_customer_id || null;
    } catch (e) {
      // ignore
    }

    if (!OK.has(planStatus)) {
      // 403 keeps semantics consistent; frontend can show nice message
      return {
        statusCode: 403,
        body:
          "Creating a team requires an active Remie CRM subscription on your own account.",
      };
    }

    // ---- Parse ----
    let name = "";
    try {
      const body = JSON.parse(event.body || "{}");
      name = (body.name || "").trim();
    } catch {
      // noop
    }
    if (!name) {
      return { statusCode: 400, body: "Missing team name" };
    }

    // ---- Ensure Stripe customer (for this OWNER) ----
    if (!stripeCustomerId) {
      // fallback: try to read auth.users for email
      if (!userEmail) {
        try {
          const { data: authUser } = await supa.auth.admin.getUserById(userId);
          userEmail = authUser?.user?.email || null;
        } catch {
          /* noop */
        }
      }
      const customer = await stripe.customers.create({
        email: userEmail || undefined,
        metadata: { user_id: userId },
      });
      stripeCustomerId = customer.id;

      // Write back
      try {
        await supa
          .from("profiles")
          .update({ stripe_customer_id: stripeCustomerId })
          .eq("id", userId);
      } catch (e) {
        console.warn(
          "[create-team] could not update profiles.stripe_customer_id:",
          e?.message || e
        );
      }
    }

    // ---- Create subscription with seat price (quantity 0) ----
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
      console.error(
        "[create-team] Stripe subscription error:",
        e?.message || e
      );
      return {
        statusCode: 400,
        body: `Stripe error: ${e?.message || "create subscription failed"}`,
      };
    }

    // ---- Create team ----
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
      console.error(
        "[create-team] Supabase insert teams failed:",
        e?.message || e
      );
      return { statusCode: 500, body: "Failed to create team record" };
    }

    // ---- Add owner membership (owner is NOT billed as a seat) ----
    try {
      const { error } = await supa
        .from("user_teams")
        .upsert({
          user_id: userId,
          team_id: team.id,
          role: "owner",
          status: "active",
          email: userEmail || null, // optional denormalized email
          joined_at: new Date().toISOString(),
        }, { onConflict: "team_id,user_id" });
      if (error) throw error;
    } catch (e) {
      console.error(
        "[create-team] Supabase upsert user_teams failed:",
        e?.message || e
      );
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
