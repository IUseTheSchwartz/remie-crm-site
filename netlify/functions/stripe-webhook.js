// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUBS_TABLE = "subscriptions";
const WALLET_TABLE = "user_wallets";

const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

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

    // Only metadata-based + customer.metadata-based resolution (no profiles)
    async function resolveUserId({ sub = null, customerId = null, session = null }) {
      try {
        let userId =
          sub?.metadata?.app_user_id ||
          session?.metadata?.app_user_id ||
          session?.subscription_metadata?.app_user_id ||
          null;

        if (!userId && customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          userId = customer?.metadata?.user_id || null;
        }
        return userId || null;
      } catch {
        return null;
      }
    }

    async function getPlanName(sub) {
      try {
        const firstItem = Array.isArray(sub.items?.data) ? sub.items.data[0] : null;
        if (!firstItem) return null;
        const price = firstItem.price;
        if (!price) return null;
        if (price.nickname) return price.nickname;

        if (price.product) {
          const product =
            typeof price.product === "string"
              ? await stripe.products.retrieve(price.product)
              : price.product;
          return product?.name || null;
        }
        return null;
      } catch {
        return null;
      }
    }

    // Insert/update subscriptions row
    async function upsertSubscription(sub) {
      const customerId = sub.customer || null;
      const userId = await resolveUserId({ sub, customerId });
      const plan_name = await getPlanName(sub);

      const payload = {
        user_id: userId, // may be null if we cannot resolve yet
        plan_name,
        status: sub.status,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id, // PRIMARY KEY/UNIQUE in your table
        current_period_end: iso(sub.current_period_end),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from(SUBS_TABLE)
        .upsert(payload, { onConflict: "stripe_subscription_id" });

      if (error) {
        console.error("[Webhook] subscriptions upsert error:", error);
      } else {
        console.log("[Webhook] subscriptions upsert ok:", sub.id, "user:", userId);
      }
    }

    // After checkout completes, we can often map the customer -> user id;
    // Use that to backfill any subs rows missing user_id.
    async function backfillUserIdForCustomer(customerId, userId) {
      if (!customerId || !userId) return;
      const { error } = await supabase
        .from(SUBS_TABLE)
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq("stripe_customer_id", customerId)
        .is("user_id", null); // only fill missing
      if (error) {
        console.error("[Webhook] backfill user_id failed:", error);
      } else {
        console.log("[Webhook] backfilled user_id for customer", customerId);
      }
    }

    async function creditWalletTopup(session) {
      const purpose =
        session.metadata?.purpose ||
        session.payment_intent?.metadata?.purpose ||
        "";

      if (purpose !== "wallet_topup") return;

      const userId =
        session.metadata?.app_user_id ||
        session.payment_intent?.metadata?.app_user_id;
      const amountCents = session.amount_total || 0;

      if (!userId || !amountCents) {
        console.warn("[Wallet] Missing user or amount on wallet_topup session", session.id);
        return;
      }

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

      console.log("[Wallet] Credited", amountCents, "cents to", userId, "from session", session.id);
    }

    // ----- event routing -----
    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(evt.data.object);
        break;

      case "checkout.session.completed": {
        const session = evt.data.object;
        // Backfill user_id on any subscription rows for this customer
        const userId = await resolveUserId({ session, customerId: session.customer });
        await backfillUserIdForCustomer(session.customer, userId);

        // Wallet top-ups (kept)
        await creditWalletTopup(session);
        break;
      }

      default:
        // ignore others
        break;
    }

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("stripe-webhook fatal error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
