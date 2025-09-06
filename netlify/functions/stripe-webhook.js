// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUBS_TABLE = "subscriptions";
const MAP_TABLE = "user_stripe_customers";
const WALLET_TABLE = "user_wallets";

const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE) : null;

export async function handler(event) {
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn("[Webhook] Missing STRIPE_WEBHOOK_SECRET");
      return { statusCode: 500, body: "Missing webhook secret" };
    }
    if (!supabase) {
      console.warn("[Webhook] Supabase admin client not configured");
      return { statusCode: 500, body: "Supabase not configured" };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body;

    let evt;
    try {
      evt = stripe.webhooks.constructEvent(
        rawBody,
        event.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[Webhook] Signature verification failed:", err.message);
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    const iso = (tsSec) => (tsSec ? new Date(tsSec * 1000).toISOString() : null);

    // Primary resolution: metadata + mapping table
    async function resolveUserId({ sub = null, customerId = null, session = null }) {
      // 1) Try direct metadata first
      let userId =
        sub?.metadata?.app_user_id ||
        session?.metadata?.app_user_id ||
        session?.subscription_metadata?.app_user_id ||
        null;

      // 2) If missing, try mapping table by customer id
      if (!userId && customerId) {
        const { data: map } = await supabase
          .from(MAP_TABLE)
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        userId = map?.user_id || null;
      }

      // 3) Final fallback: Stripe customer metadata (if present)
      if (!userId && customerId) {
        const customer = await stripe.customers.retrieve(customerId);
        userId = customer?.metadata?.user_id || null;
      }

      return userId || null;
    }

    async function upsertSubscription(sub) {
      const customerId = sub.customer || null;
      const userId = await resolveUserId({ sub, customerId });

      const payload = {
        user_id: userId, // may be null initially; we'll backfill on checkout.session.completed
        plan_name: null, // optional (omit lookups for speed)
        status: sub.status,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id, // PRIMARY KEY/UNIQUE
        current_period_end: iso(sub.current_period_end),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from(SUBS_TABLE)
        .upsert(payload, { onConflict: "stripe_subscription_id" });

      if (error) console.error("[Webhook] subscriptions upsert error:", error);
      else console.log("[Webhook] subscriptions upsert ok:", sub.id, "user:", userId);
    }

    // Backfill: when we finally know (or confirm) user_id at checkout completion,
    // set user_id on ANY subscription rows for that customer that are still null.
    async function backfillUserIdForCustomer(customerId, userId) {
      if (!customerId || !userId) return;
      const { error } = await supabase
        .from(SUBS_TABLE)
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq("stripe_customer_id", customerId)
        .is("user_id", null);
      if (error) console.error("[Webhook] backfill user_id failed:", error);
      else console.log("[Webhook] backfilled user_id for customer", customerId);
    }

    async function creditWalletTopup(session) {
      const purpose =
        session.metadata?.purpose || session.payment_intent?.metadata?.purpose || "";
      if (purpose !== "wallet_topup") return;

      const userId =
        session.metadata?.app_user_id || session.payment_intent?.metadata?.app_user_id;
      const amountCents = session.amount_total || 0;
      if (!userId || !amountCents) return;

      const { data: wallet } = await supabase
        .from(WALLET_TABLE)
        .select("balance_cents")
        .eq("user_id", userId)
        .maybeSingle();

      if (wallet) {
        const { error } = await supabase
          .from(WALLET_TABLE)
          .update({ balance_cents: wallet.balance_cents + amountCents })
          .eq("user_id", userId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from(WALLET_TABLE)
          .upsert({ user_id: userId, balance_cents: amountCents });
        if (error) throw error;
      }
    }

    // ---- route events ----
    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(evt.data.object);
        break;

      case "checkout.session.completed": {
        const session = evt.data.object;
        const userId = await resolveUserId({ session, customerId: session.customer });

        // Ensure mapping exists (in case checkout happened via Payment Link)
        if (userId && session.customer) {
          await supabase
            .from(MAP_TABLE)
            .upsert({ user_id: userId, stripe_customer_id: session.customer });
        }

        await backfillUserIdForCustomer(session.customer, userId);
        await creditWalletTopup(session);
        break;
      }

      default:
        break;
    }

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("stripe-webhook fatal error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
