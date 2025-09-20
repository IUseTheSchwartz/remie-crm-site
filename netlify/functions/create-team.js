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
const norm = (s) => (s || "").toLowerCase().trim();

/** Check DB for a personal sub; if not found, try Stripe directly. */
async function userHasPersonalSub({ supa, stripe, userId }) {
  // 1) DB: by user_id
  const { data: byUser } = await supa
    .from("subscriptions")
    .select("status, current_period_end, stripe_customer_id")
    .eq("user_id", userId)
    .order("current_period_end", { ascending: false, nullsLast: true })
    .limit(1);

  if (Array.isArray(byUser) && byUser.length) {
    const s = norm(byUser[0].status);
    if (ACTIVE_SET.has(s))
      return { ok: true, via: "db:user_id", customerId: byUser[0].stripe_customer_id || null };
  }

  // 2) DB: via mapping table
  const { data: map } = await supa
    .from("user_stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  const mappedCustomer = map?.stripe_customer_id || null;

  if (mappedCustomer) {
    const { data: byCus } = await supa
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("stripe_customer_id", mappedCustomer)
      .order("current_period_end", { ascending: false, nullsLast: true })
      .limit(1);

    if (Array.isArray(byCus) && byCus.length) {
      const s = norm(byCus[0].status);
      if (ACTIVE_SET.has(s)) return { ok: true, via: "db:customer", customerId: mappedCustomer };
    }
  }

  // 3) Stripe fallback
  let customerId = mappedCustomer;
  if (!customerId) {
    try {
      const { data: authUser } = await supa.auth.admin.getUserById(userId);
      const email = authUser?.user?.email || null;

      if (email) {
        const list = await stripe.customers.list({ email, limit: 1 });
        if (list?.data?.length) {
          customerId = list.data[0].id;
          // Save mapping
          await supa
            .from("user_stripe_customers")
            .upsert({ user_id: userId, stripe_customer_id: customerId });
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!customerId) {
    // create a customer so team creation can proceed
    const created = await stripe.customers.create({ metadata: { user_id: userId } });
    customerId = created.id;
    await supa
      .from("user_stripe_customers")
      .upsert({ user_id: userId, stripe_customer_id: customerId });
  }

  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });

  const liveOk = subs.data?.some((s) => ACTIVE_SET.has(norm(s.status)));
  if (liveOk) return { ok: true, via: "stripe", customerId };

  return { ok: false, via: "none", customerId };
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST")
      return { statusCode: 405, body: "Method not allowed" };

    assertEnv();

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supa = supaAdmin();

    // auth from frontend
    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    // parse body
    let name = "";
    try {
      const body = JSON.parse(event.body || "{}");
      name = (body.name || "").trim();
    } catch {}
    if (!name) return { statusCode: 400, body: "Missing team name" };

    // ✅ Only personal subscribers may create a team
    const check = await userHasPersonalSub({ supa, stripe, userId });
    if (!check.ok) {
      return {
        statusCode: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "needs_subscription", via: check.via }),
      };
    }
    const stripeCustomerId = check.customerId;

    // Create the team’s seats subscription (owner NOT a seat → quantity 0)
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

    // Create team
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

    // 👇 FIX: upsert the owner membership (idempotent, avoids unique-violation)
    try {
      const { error } = await supa
        .from("user_teams")
        .upsert(
          { user_id: userId, team_id: team.id, role: "owner", status: "active" },
          { onConflict: "user_id,team_id" }
        );
      if (error) throw error;
    } catch (e) {
      console.error("[create-team] Supabase upsert user_teams failed:", e?.message || e);
      return {
        statusCode: 500,
        body: `Failed to join team as owner: ${e?.message || "unknown error"}`,
      };
    }

    const clientSecret =
      subscription?.latest_invoice?.payment_intent?.client_secret || null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team,
        subscriptionClientSecret: clientSecret,
        allowedVia: check.via, // "db:user_id" | "db:customer" | "stripe"
      }),
    };
  } catch (e) {
    console.error("[create-team] Uncaught error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
