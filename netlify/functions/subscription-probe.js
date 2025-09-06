// netlify/functions/subscription-probe.js
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ACTIVE_SET = new Set(["active", "trialing"]);
const norm = (s) => (s || "").toLowerCase().trim();

export async function handler(event) {
  try {
    if (event.httpMethod !== "GET")
      return { statusCode: 405, body: "Method not allowed" };
    if (!supabase) return { statusCode: 500, body: "Supabase not configured" };

    const userId = event.headers["x-user-id"];
    const includeStripe = event.queryStringParameters?.stripe === "1";

    if (!userId) return { statusCode: 401, body: "Missing x-user-id" };

    const result = { userId };

    // subscriptions by user_id
    const { data: byUser, error: e1 } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .order("current_period_end", { ascending: false, nullsLast: true })
      .limit(5);
    result.subscriptions_by_user = byUser || [];
    result.error_by_user = e1?.message || null;
    result.by_user_status_ok = byUser?.length
      ? ACTIVE_SET.has(norm(byUser[0].status))
      : false;

    // mapping
    const { data: map, error: e2 } = await supabase
      .from("user_stripe_customers")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    result.mapping = map || null;
    result.error_mapping = e2?.message || null;

    // subscriptions by customer
    if (map?.stripe_customer_id) {
      const { data: byCus, error: e3 } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("stripe_customer_id", map.stripe_customer_id)
        .order("current_period_end", { ascending: false, nullsLast: true })
        .limit(5);
      result.subscriptions_by_customer = byCus || [];
      result.error_by_customer = e3?.message || null;
      result.by_customer_status_ok = byCus?.length
        ? ACTIVE_SET.has(norm(byCus[0].status))
        : false;

      // Optional: cross-check Stripe live status (helps catch DB/env mismatch)
      if (includeStripe) {
        const subs = await stripe.subscriptions.list({
          customer: map.stripe_customer_id,
          status: "all",
          limit: 5,
        });
        result.stripe_subscriptions = subs.data?.map((s) => ({
          id: s.id,
          status: s.status,
          current_period_end: s.current_period_end,
          product: s.items?.data?.[0]?.price?.product || null,
          price: s.items?.data?.[0]?.price?.id || null,
          metadata: s.metadata || {},
        }));
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result, null, 2),
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
