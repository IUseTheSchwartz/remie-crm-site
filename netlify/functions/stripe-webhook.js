// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Your existing profile table mapping (kept) ----
const TABLE = "profiles";
const COLS = {
  id: "id",
  planStatus: "plan_status",
  trialEnd: "trial_end",
  stripeCustomerId: "stripe_customer_id",
};

// ---- Wallet table (kept) ----
const WALLET_TABLE = "user_wallets";

// ---- Subscriptions table (your existing table) ----
const SUBS_TABLE = "subscriptions";

// Supabase client (service role)
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

// Best-effort DB logging (optional table `webhook_events`)
// If you don't have this table, calls will be silently ignored.
async function logEvent(evtId, note, extra = null) {
  try {
    if (!supabase) return;
    await supabase
      .from("webhook_events")
      .upsert(
        {
          id: evtId || `evt_${Date.now()}`,
          type: "stripe",
          created_at: new Date().toISOString(),
          note: note?.slice(0, 200) || null,
          payload: extra || null, // requires payload jsonb column if you have it
        },
        { onConflict: "id" }
      );
  } catch {
    // no-op
  }
}

export async function handler(event) {
  try {
    const sig = event.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn("[Webhook] STRIPE_WEBHOOK_SECRET not set");
      return { statusCode: 500, body: "Missing webhook secret" };
    }

    // ✅ Netlify raw body handling (base64 vs raw)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body;

    let evt;
    try {
      evt = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      console.error("[Webhook] Signature verification failed:", err.message);
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    // ---------- Helpers (kept + extended) ----------

    /**
     * Resolve your app user id.
     * Order:
     * 1) sub/session metadata.app_user_id
     * 2) stripe customer.metadata.user_id
     * 3) fallback: exact email match in profiles.email
     */
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

            if (email && supabase) {
              const emailLc = email.trim().toLowerCase();
              const { data: match, error: mErr } = await supabase
                .from(TABLE)
                .select(`${COLS.id}, email`)
                .eq("email", emailLc)
                .limit(2);

              if (mErr) {
                console.warn("[Webhook] email match lookup error:", mErr?.message || mErr);
              } else if (Array.isArray(match) && match.length === 1) {
                appUserId = match[0][COLS.id];
              } else if (Array.isArray(match) && match.length > 1) {
                console.warn(
                  "[Webhook] Multiple profiles share email—cannot resolve uniquely:",
                  emailLc
                );
              }
            }
          }
        }
        return appUserId || null;
      } catch (e) {
        console.warn("[Webhook] resolveAppUserId error:", e?.message || e);
        return null;
      }
    }

    // Upsert a normalized subscription row
    async function upsertIntoSubscriptions(sub) {
      if (!supabase) return;

      const customerId = sub.customer || null;
      const userId = await resolveAppUserId({ sub, customerId }); // ← we will store both user_id and app_user_id for safety
      const firstItem = Array.isArray(sub.items?.data) ? sub.items.data[0] : null;
      const price = firstItem?.price || null;
      const priceId = price?.id || null;
      const productId = price?.product || null;
      const qty = firstItem?.quantity ?? null;
      const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

      // Single, consistent payload (use the column names you need)
      const payload = {
        id: sub.id, // if your table uses id PK, this will upsert by PK
        stripe_subscription_id: sub.id, // if your table uses this as unique, it's still present
        stripe_customer_id: customerId,
        user_id: userId,           // <-- what SubscriptionGate queries
        app_user_id: userId,       // <-- also write this for backwards-compat
        status: sub.status,
        price_id: priceId,
        product_id: productId,
        quantity: qty,
        current_period_start: iso(sub.current_period_start),
        current_period_end: iso(sub.current_period_end),
        cancel_at: iso(sub.cancel_at),
        canceled_at: iso(sub.canceled_at),
        cancel_at_period_end: sub.cancel_at_period_end ?? null,
        trial_end: iso(sub.trial_end),
        raw: sub, // keep full snapshot if you have a jsonb 'raw' column
        updated_at: new Date().toISOString(),
      };

      // Try upsert by PK 'id'; if your table uses a different constraint, this still works
      try {
        const { error } = await supabase.from(SUBS_TABLE).upsert(payload);
        if (error) throw error;
        console.log("[Webhook] subscriptions upsert ok:", sub.id, "user:", userId);
      } catch (e) {
        console.error("[Webhook] subscriptions upsert failed:", e?.message || e);
        await logEvent(evt.id, "subscriptions upsert failed", { err: e?.message });
      }
    }

    // Persist subscription status for your user (kept; plus email fallback + subs upsert)
    async function recordSubscription(sub) {
      const status = sub.status; // 'trialing', 'active', 'past_due', 'canceled', 'unpaid', maybe 'paused'
      const customerId = sub.customer;
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

      let appUserId = sub.metadata?.app_user_id || null;
      if (!appUserId) appUserId = await resolveAppUserId({ sub, customerId });

      console.log("[Billing] recordSubscription", { appUserId, customerId, status, trialEnd });

      // Always persist a subscriptions row (even if user unknown yet)
      await upsertIntoSubscriptions(sub);

      // Keep your original profiles update if we have a resolved user
      if (!supabase || !appUserId) return;

      const payload = {
        [COLS.planStatus]: status,
        [COLS.trialEnd]: trialEnd,
        [COLS.stripeCustomerId]: customerId,
      };

      const { error } = await supabase.from(TABLE).update(payload).eq(COLS.id, appUserId);
      if (error) {
        console.error("[Webhook] Supabase update error:", error);
        await logEvent(evt.id, "profiles update error", { err: error.message, appUserId });
      } else {
        console.log("[Webhook] Updated plan for user:", appUserId);
      }
    }

    // Capture checkout completion to store customer id (kept; + email fallback)
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
          await logEvent(evt.id, "customer link error", { err: error.message, appUserId });
        } else {
          console.log("[Webhook] Linked stripe_customer_id for", appUserId);
        }
      } catch (e) {
        console.warn("[Webhook] recordCheckoutSession error:", e?.message || e);
      }
    }

    // Wallet top-up (kept)
    async function creditWalletTopup(session) {
      if (!supabase) return;

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

      // best-effort idempotency log
      try {
        await supabase
          .from("webhook_events")
          .upsert(
            { id: evt.id, type: "stripe", created_at: new Date().toISOString() },
            { onConflict: "id" }
          );
      } catch {
        // no-op
      }

      // Credit wallet
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

    // ---------- Event routing (kept + extended) ----------
    switch (evt.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await recordSubscription(evt.data.object);
        break;

      case "checkout.session.completed": {
        const session = evt.data.object;
        await recordCheckoutSession(session);
        await creditWalletTopup(session);
        break;
      }

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