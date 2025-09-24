// File: netlify/functions/stripe-webhook.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.config = { path: "/.netlify/functions/stripe-webhook" };

function priceToPlanName(price) {
  return (price && (price.nickname || price.product)) || "Unknown";
}
const epochToISO = (s) => (s ? new Date(s * 1000).toISOString() : null);

// ✅ Old behavior that worked: resolve user by metadata.user_id, then by email via admin.listUsers
async function resolveSupabaseUserId({ supabase, metadataUserId, email }) {
  if (metadataUserId) return metadataUserId;
  if (!email) return null;

  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const match = data?.users?.find(
      (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
    );
    if (match) return match.id;
    if (!data?.users?.length || data.users.length < 100) break;
  }
  return null;
}

/**
 * Apply wallet credit with idempotency via wallet_ledger.stripe_event_id.
 * Assumptions:
 * - Table `wallet_ledger` with columns: user_id (uuid), change_cents (int), reason (text), stripe_event_id (text unique), stripe_session_id (text)
 * - Table `profiles` has column `text_balance_cents` (int).
 *
 * If you already have an RPC like incr_text_balance(p_user_id uuid, p_delta_cents int),
 * this function tries it first; falls back to read+update if RPC is missing.
 */
async function applyWalletCredit({ supabase, userId, amountCents, stripeEventId, sessionId }) {
  // 0) Guard
  if (!userId || !Number.isFinite(Number(amountCents)) || amountCents <= 0) {
    return { ok: false, reason: "invalid_params" };
  }

  // 1) Idempotency: check if we already applied this event
  const { data: existing, error: checkErr } = await supabase
    .from("wallet_ledger")
    .select("id")
    .eq("stripe_event_id", stripeEventId)
    .maybeSingle();
  if (checkErr) {
    console.error("[wallet] ledger check error:", checkErr);
    throw checkErr;
  }
  if (existing) return { ok: true, alreadyApplied: true };

  // 2) Insert ledger row
  const { error: ledgerErr } = await supabase.from("wallet_ledger").insert({
    user_id: userId,
    change_cents: amountCents,
    reason: "stripe_topup",
    stripe_event_id: stripeEventId,
    stripe_session_id: sessionId,
  });
  if (ledgerErr) {
    // Unique violation (already inserted) is effectively idempotent
    if ((ledgerErr.code || "").toString() === "23505") {
      return { ok: true, alreadyApplied: true };
    }
    console.error("[wallet] insert ledger error:", ledgerErr);
    throw ledgerErr;
  }

  // 3) Try RPC first (atomic increment). If missing, fall back to read+update.
  try {
    const { error: rpcErr } = await supabase.rpc("incr_text_balance", {
      p_user_id: userId,
      p_delta_cents: amountCents,
    });
    if (!rpcErr) return { ok: true, applied: true, via: "rpc" };
    console.warn("[wallet] incr_text_balance RPC not available, falling back:", rpcErr);
  } catch (e) {
    console.warn("[wallet] incr_text_balance RPC call failed, falling back:", e);
  }

  // Fallback: read current balance and update (note: not perfectly atomic under concurrency, but acceptable for most cases).
  const { data: profRow, error: profSelErr } = await supabase
    .from("profiles")
    .select("text_balance_cents")
    .eq("id", userId)
    .maybeSingle();
  if (profSelErr) {
    console.error("[wallet] select profile error:", profSelErr);
    throw profSelErr;
  }
  const current = Number(profRow?.text_balance_cents || 0);
  const next = current + Number(amountCents);

  const { error: profUpdErr } = await supabase
    .from("profiles")
    .update({ text_balance_cents: next })
    .eq("id", userId);
  if (profUpdErr) {
    console.error("[wallet] update profile error:", profUpdErr);
    throw profUpdErr;
  }

  return { ok: true, applied: true, via: "read_update" };
}

exports.handler = async (event) => {
  const SUPABASE_SERVICE_ROLE =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  const sig = event.headers["stripe-signature"];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Bad signature:", err);
    return { statusCode: 400, body: `Bad signature: ${err.message}` };
  }

  try {
    const handled = new Set([
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]);
    if (!handled.has(evt.type)) return { statusCode: 200, body: "ignored" };

    // Common vars
    let subscription, customerId, subscriptionId;
    let status = "unknown";
    let currentPeriodEnd = null;
    let planName = "Unknown";
    let customerEmail = null;
    let metadataUserId = null;

    // ---- Branch 1: Checkout completed (could be wallet top-up OR a subscription via Checkout) ----
    if (evt.type === "checkout.session.completed") {
      const session = evt.data.object;
      customerId = session.customer;
      customerEmail = session.customer_details?.email || session.customer_email || null;

      // Read both session and customer metadata
      let customer = null;
      if (customerId) {
        try {
          customer = await stripe.customers.retrieve(customerId);
        } catch (e) {
          console.warn("Unable to retrieve customer:", e?.message || e);
        }
      }

      metadataUserId =
        session?.metadata?.app_user_id ||
        session?.metadata?.user_id ||
        customer?.metadata?.user_id ||
        null;

      // 🔹 WALLET TOP-UP path: when metadata.net_topup_cents is present and the session was paid
      const netTopup = Number(session?.metadata?.net_topup_cents || 0);
      if (session.payment_status === "paid" && Number.isFinite(netTopup) && netTopup > 0) {
        const userId = await resolveSupabaseUserId({
          supabase,
          metadataUserId,
          email: customerEmail,
        });
        if (!userId) {
          console.log("⚠️ Wallet top-up but no user mapped", {
            customerId,
            customerEmail,
            metadataUserId,
          });
          return { statusCode: 200, body: "wallet: no user mapped" };
        }

        const creditRes = await applyWalletCredit({
          supabase,
          userId,
          amountCents: netTopup,
          stripeEventId: evt.id,
          sessionId: session.id,
        });
        if (!creditRes.ok) {
          console.error("[wallet] credit failed:", creditRes);
          return { statusCode: 500, body: "wallet credit failed" };
        }

        // ✅ Done for wallet top-ups (do NOT touch subscriptions here)
        return { statusCode: 200, body: "wallet ok" };
      }

      // Otherwise, try to map subscription from this customer/session (your existing behavior)
      const subs = customerId
        ? await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 1 })
        : { data: [] };
      subscription = subs.data?.[0] || null;

      // If no subscription exists, simply acknowledge
      if (!subscription) {
        return { statusCode: 200, body: "checkout ok (no subscription and no wallet)" };
      }
    } else {
      // ---- Branch 2: Direct subscription events ----
      subscription = evt.data.object;
      subscriptionId = subscription.id;
      customerId = subscription.customer;
      currentPeriodEnd = epochToISO(subscription.current_period_end);
      status = (subscription.status || "unknown").toLowerCase();
      planName = priceToPlanName(subscription.items?.data?.[0]?.price);

      const cust = customerId ? await stripe.customers.retrieve(customerId) : null;
      customerEmail = cust?.email || null;
      metadataUserId =
        subscription?.metadata?.app_user_id ||
        subscription?.metadata?.user_id ||
        cust?.metadata?.user_id ||
        null;
    }

    // If we got a subscription in either branch, upsert it
    if (subscription) {
      subscriptionId = subscription.id;
      currentPeriodEnd = epochToISO(subscription.current_period_end);
      status = (subscription.status || "unknown").toLowerCase();
      planName = priceToPlanName(subscription.items?.data?.[0]?.price);
    }

    // 🔑 Map to your Supabase user
    const userId = await resolveSupabaseUserId({
      supabase,
      metadataUserId,
      email: customerEmail,
    });
    if (!userId) {
      console.log("⚠️ No user mapped (subscription path)", {
        customerId,
        customerEmail,
        metadataUserId,
      });
      return { statusCode: 200, body: "no user mapped" };
    }

    // ✅ UPSERT subscription snapshot
    const { error } = await supabase
      .from("subscriptions")
      .upsert(
        {
          user_id: userId,
          plan_name: planName,
          status,
          stripe_customer_id: customerId || null,
          stripe_subscription_id: subscriptionId || null,
          current_period_end: currentPeriodEnd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_subscription_id" }
      );

    if (error) throw error;

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return { statusCode: 500, body: err.message || "Server error" };
  }
};
