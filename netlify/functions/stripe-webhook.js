// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- profiles mapping (kept) ----
const TABLE = "profiles";
const COLS = {
  id: "id",
  planStatus: "plan_status",
  trialEnd: "trial_end",
  stripeCustomerId: "stripe_customer_id",
};

// Existing tables
const SUBS_TABLE = "subscriptions";   // your existing schema
const WALLET_TABLE = "user_wallets";  // unchanged

// Supabase admin client
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

export async function handler(event) {
  try {
    // --- sanity ---
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn("[Webhook] Missing STRIPE_WEBHOOK_SECRET");
      return { statusCode: 500, body: "Missing webhook secret" };
    }
    if (!supabase) {
      console.warn("[Webhook] Supabase admin client not configured");
      return { statusCode: 500, body: "Supabase not configured" };
    }

    // ✅ Netlify body handling
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

    // ---------- helpers ----------
    const iso = (tsSec) => (tsSec ? new Date(tsSec * 1000).toISOString() : null);

    // Resolve your app user id:
    // 1) sub/session metadata.app_user_id
    // 2) stripe customer.metadata.user_id
    // 3) fallback: profiles.email == customer email (exact single match)
    async function resolveAppUserId({ sub = null, customerId = null, session = null }) {
      try {
        let appUserId =
          sub?.metadata?.app_user_id ||
          session?.metadata?.app_user_id ||
          session?.subscription_metadata?.app_user_id ||
          null;

        if (!appUserId && customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          appUserId = customer?.metadata?.user_id || null;

          if (!appUserId) {
            const email =
              customer?.email ||
              session?.customer_details?.email ||
              session?.customer_email ||
              null;

            if (email) {
              const emailLc = email.trim().toLowerCase();
              const { data: match } = await supabase
                .from(TABLE)
                .select(`${COLS.id}, email`)
                .eq("email", emailLc)
                .limit(2);

              if (Array.isArray(match) && match.length === 1) {
                appUserId = match[0][COLS.id];
              }
            }
          }
        }
        return appUserId || null;
      } catch {
        return null;
      }
    }

    // Get a human-friendly plan name (best-effort)
    async function getPlanName(sub) {
      try {
        const firstItem = Array.isArray(sub.items?.data) ? sub.items.data[0] : null;
        if (!firstItem) return null;
        const price = firstItem.price;
        if (!price) return null;
        if (price.nickname) return price.nickname; // often “Monthly” etc.

        // try to pull product name
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

    // Upsert exactly into your subscriptions table schema
    async function upsertSubscriptionRow(sub) {
      const customerId = sub.customer || null;
      const userId = await resolveAppUserId({ sub, customerId });

      const plan_name = await getPlanName(sub);
      const payload = {
        user_id: userId,                         // uuid (nullable if unresolved)
        id: sub.id,                              // ok to store stripe sub id here (you had this column)
        status: sub.status,                      // text
        plan_name: plan_name,                    // text
        stripe_customer_id: customerId,          // text
        stripe_subscription_id: sub.id,          // text (unique)
        current_period_end: iso(sub.current_period_end), // timestamptz
        updated_at: new Date().toISOString(),    // timestamptz
      };

      // If your table expects created_at on first insert, Postgres default handles it.
      // We use onConflict by stripe_subscription_id (as you indicated).
      const { error } = await supabase
        .from(SUBS_TABLE)
        .upsert(payload, { onConflict: "stripe_subscription_id" });

      if (error) {
        console.error("[Webhook] subscriptions upsert error:", error);
      } else {
        console.log("[Webhook] subscriptions upsert ok:", sub.id, "user:", userId);
      }
    }

    // Keep your original profiles update (plan_status, trial_end, stripe_customer_id)
    async function recordSubscription(sub) {
      await upsertSubscriptionRow(sub); // always record row in subscriptions

      const status = sub.status;
      const customerId = sub.customer;
      const trialEnd = iso(sub.trial_end);

      let appUserId = sub.metadata?.app_user_id || null;
      if (!appUserId) appUserId = await resolveAppUserId({ sub, customerId });

      console.log("[Billing] recordSubscription", {
        appUserId,
        customerId,
        status,
        trialEnd,
      });

      if (!appUserId) return; // can't update profiles without user

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
        console.error("[Webhook] profiles update error:", error);
      } else {
        console.log("[Webhook] Updated plan for user:", appUserId);
      }
    }

    // Link stripe_customer_id on checkout completion (kept)
    async function recordCheckoutSession(session) {
      try {
        const customerId = session.customer;

        let appUserId =
          session.metadata?.app_user_id ||
          session.subscription_metadata?.app_user_id ||
          null;

        if (!appUserId) appUserId = await resolveAppUserId({ session, customerId });

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

    // Wallet top-up (kept)
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

      // lightweight idempotency
      try {
        await supabase
          .from("webhook_events")
          .upsert(
            { id: evt.id, type: "stripe", created_at: new Date().toISOString() },
            { onConflict: "id" }
          );
      } catch {
        // ignore if table doesn't exist
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

    // ---------- routing ----------
    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await recordSubscription(evt.data.object);
        break;

      case "checkout.session.completed":
        await recordCheckoutSession(evt.data.object);
        await creditWalletTopup(evt.data.object);
        break;

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