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

// ---- New: wallet table name (no schema changes required) ----
const WALLET_TABLE = "user_wallets";

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

    // NEW: Resolve app user id using subscription/customer metadata, then fallback to email
    async function resolveAppUserId({ sub = null, customerId = null, session = null }) {
      try {
        // 1) Prefer metadata (existing behavior)
        let appUserId = sub?.metadata?.app_user_id || session?.metadata?.app_user_id || null;

        // 2) Fallback to Customer metadata
        if (!appUserId && customerId) {
          try {
            const customer = await stripe.customers.retrieve(customerId);
            appUserId = customer?.metadata?.user_id || null;

            // 3) Final fallback: look up profiles by email if still unknown
            if (!appUserId) {
              const email =
                customer?.email ||
                session?.customer_details?.email ||
                session?.customer_email ||
                null;

              if (email && supabase) {
                // normalize email for lookup
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
            console.warn("[Webhook] resolveAppUserId: could not retrieve customer", e?.message || e);
          }
        }

        return appUserId || null;
      } catch (e) {
        console.warn("[Webhook] resolveAppUserId error:", e?.message || e);
        return null;
      }
    }

    // Persist subscription status for your user
    async function recordSubscription(sub) {
      const status = sub.status; // 'trialing', 'active', 'past_due', 'canceled', 'unpaid', maybe 'paused'
      const customerId = sub.customer;
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

      // Prefer subscription metadata; fall back to customer metadata; NEW: fall back to email
      let appUserId =
        sub.metadata?.app_user_id ||
        null;

      if (!appUserId) {
        appUserId = await resolveAppUserId({ sub, customerId });
      }

      console.log("[Billing] recordSubscription", { appUserId, customerId, status, trialEnd });

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

    // Capture checkout completion to store customer id
    async function recordCheckoutSession(session) {
      try {
        const customerId = session.customer;

        // As before:
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

    // NEW: Credit SMS wallet for one-time top-ups created by create-checkout-session
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
      let canProcess = true;
      try {
        const { error } = await supabase
          .from("webhook_events")
          .upsert(
            { id: evt.id, type: "stripe", created_at: new Date().toISOString() },
            { onConflict: "id" }
          );
        if (error) {
          // If the table doesn't exist, we continue (best-effort). For stronger guarantees,
          // create table webhook_events(id text primary key, type text, created_at timestamptz).
          console.warn("[Wallet] webhook_events upsert error (non-fatal):", error.message);
        }
      } catch {
        // no-op
      }

      if (!canProcess) return;

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