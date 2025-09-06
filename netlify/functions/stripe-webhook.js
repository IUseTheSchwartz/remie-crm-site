// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Your tables ----
const SUBS_TABLE = "subscriptions";    // what SubscriptionGate reads
const WALLET_TABLE = "user_wallets";   // your existing wallet table (kept)

// Supabase admin client
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

export async function handler(event) {
  try {
    // Basic env checks
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn("[Webhook] Missing STRIPE_WEBHOOK_SECRET");
      return { statusCode: 500, body: "Missing webhook secret" };
    }
    if (!supabase) {
      console.warn("[Webhook] Supabase admin client not configured");
      return { statusCode: 500, body: "Supabase not configured" };
    }

    // ✅ Netlify body handling (may arrive base64-encoded)
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

    // Resolve your Supabase user id (uuid in auth.users)
    // 1) sub/session metadata.app_user_id
    // 2) stripe customer.metadata.user_id
    // 3) fallback: email match in auth.users.email (single exact match)
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

          if (!userId) {
            const email =
              customer?.email ||
              session?.customer_details?.email ||
              session?.customer_email ||
              null;

            if (email) {
              const emailLc = email.trim().toLowerCase();
              const { data: match } = await supabase
                .from("auth.users") // query system view via RPC would need auth; this is a shortcut:
                .select("id, email") // NOTE: if this select fails due to RLS, remove the email fallback
                .eq("email", emailLc)
                .limit(2);

              // If your project blocks selecting from auth.users, remove this block
              if (Array.isArray(match) && match.length === 1) {
                userId = match[0].id;
              }
            }
          }
        }
        return userId || null;
      } catch {
        return null;
      }
    }

    // Best-effort plan name (optional prettiness)
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

    // Upsert into your subscriptions table ONLY
    async function upsertSubscription(sub) {
      const customerId = sub.customer || null;
      const userId = await resolveUserId({ sub, customerId });
      const plan_name = await getPlanName(sub);

      const payload = {
        user_id: userId,                         // what your gate checks
        plan_name: plan_name,                    // optional
        status: sub.status,                      // active|trialing|...
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,          // PRIMARY KEY / UNIQUE in SQL below
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

    // Wallet top-up (kept exactly as behavior)
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

      // Idempotency best-effort (if you have webhook_events, otherwise ignore)
      try {
        await supabase
          .from("webhook_events")
          .upsert(
            { id: evt.id, type: "stripe", created_at: new Date().toISOString() },
            { onConflict: "id" }
          );
      } catch {
        // ignore if the table doesn't exist
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

    // ---------- route the event ----------
    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(evt.data.object);
        break;

      case "checkout.session.completed":
        // We no longer update profiles here; nothing to do unless it's a wallet topup.
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
