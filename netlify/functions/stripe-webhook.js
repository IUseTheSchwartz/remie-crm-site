// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Adjust these to your schema if needed ----
const TABLE = "profiles";
const COLS = {
  id: "id", // user id column
  planStatus: "plan_status",
  trialEnd: "trial_end",
  stripeCustomerId: "stripe_customer_id",
};
// -----------------------------------------------

// Optional Supabase client for persistence (no-op if envs missing)
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

export async function handler(event) {
  try {
    const sig = event.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn("[Webhook] STRIPE_WEBHOOK_SECRET not set");
      return { statusCode: 500, body: "Missing webhook secret" };
    }

    let evt;
    try {
      evt = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    } catch (err) {
      console.error("[Webhook] Signature verification failed:", err.message);
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    // Helper: persist subscription status for a given subscription object
    async function recordSubscription(sub) {
      const status = sub.status; // 'trialing', 'active', 'past_due', 'canceled', 'unpaid', maybe 'paused'
      const customerId = sub.customer;
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

      // Prefer subscription.metadata.app_user_id (we set this at Checkout creation)
      let appUserId = sub.metadata?.app_user_id || null;

      // If missing, try the customer metadata
      if (!appUserId && customerId) {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          appUserId = customer?.metadata?.user_id || null;
        } catch (e) {
          console.warn("[Webhook] Could not fetch customer to read metadata", e?.message || e);
        }
      }

      console.log("[Billing] recordSubscription", { appUserId, customerId, status, trialEnd });

      if (!supabase || !appUserId) return; // no-op if we can’t persist

      const payload = {
        [COLS.planStatus]: status,
        [COLS.trialEnd]: trialEnd,
        [COLS.stripeCustomerId]: customerId,
      };

      const { error } = await supabase
        .from(TABLE)
        .update(payload)
        .eq(COLS.id, appUserId);

      if (error) {
        console.error("[Webhook] Supabase update error:", error);
      } else {
        console.log("[Webhook] Updated plan for user:", appUserId);
      }
    }

    // Some teams also like to capture checkout.session.completed
    // to store customer id as soon as checkout finishes.
    async function recordCheckoutSession(session) {
      try {
        const customerId = session.customer;
        const appUserId =
          session.metadata?.app_user_id ||
          session.subscription_metadata?.app_user_id || // just in case
          null;

        if (!supabase || !appUserId || !customerId) return;

        const { error } = await supabase
          .from(TABLE)
          .update({ [COLS.stripeCustomerId]: customerId })
          .eq(COLS.id, appUserId);

        if (error) {
          console.error("[Webhook] Supabase customer link error:", error);
        } else {
          console.log("[Webhook] Linked stripe_customer_id for", appUserId);
        }
      } catch (e) {
        console.warn("[Webhook] recordCheckoutSession error:", e?.message || e);
      }
    }

    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await recordSubscription(evt.data.object);
        break;

      case "checkout.session.completed":
        await recordCheckoutSession(evt.data.object);
        break;

      default:
        // no-op for other events
        break;
    }

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("stripe-webhook error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
