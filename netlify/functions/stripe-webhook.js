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

// ---- Existing subscriptions table name (we will upsert into this) ----
const SUBS_TABLE = "subscriptions";

// Supabase client (supports either env var name for service role)
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
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

    // ---------- Helpers (kept + extended) ----------

    /**
     * Resolve your app user id.
     * Order of preference:
     * 1) sub.metadata.app_user_id or session.metadata.app_user_id
     * 2) stripe customer metadata.user_id
     * 3) fallback: look up profiles by customer email (exact single match)
     */
    async function resolveAppUserId({ sub = null, customerId = null, session = null }) {
      try {
        // 1) from subscription/session metadata
        let appUserId =
          sub?.metadata?.app_user_id ||
          session?.metadata?.app_user_id ||
          session?.subscription_metadata?.app_user_id ||
          null;

        // 2) from customer metadata
        if (!appUserId && customerId) {
          try {
            const customer = await stripe.customers.retrieve(customerId);
            appUserId = customer?.metadata?.user_id || null;

            // 3) fallback: email match
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
          } catch (e) {
            console.warn("[Webhook] resolveAppUserId: customer retrieve failed", e?.message || e);
          }
        }

        return appUserId || null;
      } catch (e) {
        console.warn("[Webhook] resolveAppUserId error:", e?.message || e);
        return null;
      }
    }

    /**
     * NEW: Upsert into your existing `subscriptions` table.
     * This tries two common schemas:
     *  A) columns like: id (PK), customer_id, app_user_id, status, price_id, quantity, period bounds, trial_end, etc.
     *  B) columns like: stripe_subscription_id (unique), stripe_customer_id, user_id, status, price_id, product_id, cancel_at_period_end, trial_end, etc.
     * If the first upsert fails due to a column mismatch, we try the second.
     */
    async function upsertIntoSubscriptions(sub) {
      if (!supabase) return;

      const customerId = sub.customer || null;
      const appUserId = await resolveAppUserId({ sub, customerId });

      const firstItem = Array.isArray(sub.items?.data) ? sub.items.data[0] : null;
      const price = firstItem?.price || null;
      const priceId = price?.id || null;
      const productId = price?.product || null;
      const qty = firstItem?.quantity ?? null;

      // Convert seconds -> ISO
      const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

      // Variant A (id as PK)
      const payloadA = {
        id: sub.id,
        customer_id: customerId,
        app_user_id: appUserId, // may be null if unresolved
        status: sub.status,
        price_id: priceId,
        quantity: qty,
        current_period_start: iso(sub.current_period_start),
        current_period_end: iso(sub.current_period_end),
        cancel_at: iso(sub.cancel_at),
        canceled_at: iso(sub.canceled_at),
        trial_end: iso(sub.trial_end),
        raw: sub, // if you have a jsonb 'raw' column
      };

      // Variant B (stripe_subscription_id as unique/PK; user_id naming)
      const payloadB = {
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
        user_id: appUserId, // may be null if unresolved
        status: sub.status,
        price_id: priceId,
        product_id: productId,
        cancel_at_period_end: sub.cancel_at_period_end ?? null,
        current_period_start: iso(sub.current_period_start),
        current_period_end: iso(sub.current_period_end),
        trial_end: iso(sub.trial_end),
      };

      // Try A first (primary key 'id')
      try {
        const { error: aErr } = await supabase
          .from(SUBS_TABLE)
          .upsert(payloadA); // relies on PK 'id' if present
        if (aErr) throw aErr;

        console.log("[Webhook] subscriptions upsert (A) ok:", sub.id, "user:", appUserId);
        return;
      } catch (e) {
        console.warn("[Webhook] subscriptions upsert (A) failed, trying (B):", e?.message || e);
      }

      // Try B next (unique 'stripe_subscription_id')
      try {
        const { error: bErr } = await supabase
          .from(SUBS_TABLE)
          .upsert(payloadB, { onConflict: "stripe_subscription_id" });
        if (bErr) throw bErr;

        console.log("[Webhook] subscriptions upsert (B) ok:", sub.id, "user:", appUserId);
      } catch (e) {
        console.error("[Webhook] subscriptions upsert failed (both attempts):", e?.message || e);
      }
    }

    // Persist subscription status for your user (kept; adds email fallback + subscriptions upsert)
    async function recordSubscription(sub) {
      const status = sub.status; // 'trialing', 'active', 'past_due', 'canceled', 'unpaid', maybe 'paused'
      const customerId = sub.customer;
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

      // Prefer subscription metadata; NEW: fall back to email if needed
      let appUserId = sub.metadata?.app_user_id || null;
      if (!appUserId) {
        appUserId = await resolveAppUserId({ sub, customerId });
      }

      console.log("[Billing] recordSubscription", { appUserId, customerId, status, trialEnd });

      // NEW: always upsert subscriptions table, even if appUserId is null (we still save the sub)
      await upsertIntoSubscriptions(sub);

      // Keep your original profiles update
      if (!supabase || !appUserId) return;

      const payload = {
        [COLS.planStatus]: status,
        [COLS.trialEnd]: trialEnd,
        [COLS.stripeCustomerId]: customerId,
      };

      const { error } = await supabase.from(TABLE).update(payload).eq(COLS.id, appUserId);
      if (error) {
        console.error("[Webhook] Supabase update error:", error);
      } else {
        console.log("[Webhook] Updated plan for user:", appUserId);
      }
    }

    // Capture checkout completion to store customer id (kept; adds email fallback)
    async function recordCheckoutSession(session) {
      try {
        const customerId = session.customer;

        let appUserId =
          session.metadata?.app_user_id ||
          session.subscription_metadata?.app_user_id ||
          null;

        // NEW: email-based fallback if still missing
        if (!appUserId) {
          appUserId = await resolveAppUserId({ session, customerId });
        }

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

    // NEW: Credit SMS wallet for one-time top-ups created by create-checkout-session (kept)
    async function creditWalletTopup(session) {
      if (!supabase) return;

      // We set this metadata when creating wallet top-up sessions:
      //   metadata: { app_user_id, purpose: "wallet_topup" }
      const purpose =
        session.metadata?.purpose ||
        session.payment_intent?.metadata?.purpose ||
        "";

      if (purpose !== "wallet_topup") return; // ignore non-topup sessions

      const userId =
        session.metadata?.app_user_id ||
        session.payment_intent?.metadata?.app_user_id;
      const amountCents = session.amount_total || 0;

      if (!userId || !amountCents) {
        console.warn("[Wallet] Missing user or amount on wallet_topup session", session.id);
        return;
      }

      // Idempotency (lightweight): try to record the event id; if table not present, continue.
      try {
        const { error } = await supabase
          .from("webhook_events")
          .upsert(
            { id: evt.id, type: "stripe", created_at: new Date().toISOString() },
            { onConflict: "id" }
          );
        if (error) {
          console.warn("[Wallet] webhook_events upsert error (non-fatal):", error.message);
        }
      } catch {
        // no-op
      }

      // Credit (upsert if wallet row doesn't exist)
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
        // Keep your existing customer-id linkage
        await recordCheckoutSession(session);
        // New: also credit wallet if this session was a wallet top-up
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