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

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

const ACTIVE_SET = new Set(["active", "trialing"]);

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST")
      return { statusCode: 405, body: "Method not allowed" };

    assertEnv();

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supa = makeSupaAdmin();

    // ---- Auth (via Netlify header from your frontend callFn) ----
    const userId = event.headers["x-user-id"];
    if (!userId) {
      console.error("[create-team] Missing X-User-Id header");
      return { statusCode: 401, body: "Not authenticated" };
    }

    // ---- Parse ----
    let name = "";
    try {
      const body = JSON.parse(event.body || "{}");
      name = (body.name || "").trim();
    } catch {}
    if (!name) return { statusCode: 400, body: "Missing team name" };

    // ---- NEW: Require personal subscription (seat members cannot create) ----
    // We check your subscriptions table for a row tied to THIS user.
    // status must be active/trialing (latest period wins).
    const { data: subRow, error: subErr } = await supa
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("user_id", userId)
      .order("current_period_end", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subErr) {
      console.warn("[create-team] subscriptions lookup error:", subErr.message || subErr);
    }
    const hasPersonalSub = !!subRow && ACTIVE_SET.has((subRow.status || "").toLowerCase());

    if (!hasPersonalSub) {
      // Seat-only users get blocked here; personal subscribers pass.
      // Use a specific body so the client can show a friendly CTA.
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "needs_subscription" }),
      };
    }

    // ---- Get or create Stripe customer for this user (optional convenience) ----
    let stripeCustomerId = null;
    let userEmail = null;

    try {
      const { data: prof } = await supa
        .from("profiles") // if you don't have profiles, you can remove this block
        .select("id, email, stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();

      stripeCustomerId = prof?.stripe_customer_id || null;
      userEmail = prof?.email || null;
    } catch (e) {
      // It's fine if you don't have profiles; we’ll just create a customer below
      console.warn("[create-team] profiles lookup failed (continuing):", e?.message || e);
    }

    if (!stripeCustomerId) {
      // As a fallback, try to read from auth admin (optional – safe to skip)
      if (!userEmail) {
        try {
          const { data: authUser } = await supa.auth.admin.getUserById(userId);
          userEmail = authUser?.user?.email || null;
        } catch (e) {
          console.warn("[create-team] auth.users lookup failed (continuing):", e?.message || e);
        }
      }

      const customer = await stripe.customers.create({
        email: userEmail || undefined,
        metadata: { user_id: userId },
      });
      stripeCustomerId = customer.id;

      // Best-effort link back if you do have a profiles table
      try {
        await supa
          .from("profiles")
          .update({ stripe_customer_id: stripeCustomerId })
          .eq("id", userId);
      } catch (e) {
        // ignore if no profiles
      }
    }

    // ---- Create Stripe subscription for seats with quantity 0 initially ----
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
      return { statusCode: 400, body: `Stripe error: ${e?.message || "create subscription failed"}` };
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
      console.error("[create-team] Supabase insert teams failed:", e?.message || e);
      return { statusCode: 500, body: "Failed to create team record" };
    }

    // ---- Add owner membership ----
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