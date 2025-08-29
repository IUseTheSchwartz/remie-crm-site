// File: netlify/functions/stripe-webhook.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.config = { path: "/.netlify/functions/stripe-webhook" };

function priceToPlanName(price) {
  return (price && (price.nickname || price.product)) || "Unknown";
}
const epochToISO = (s) => (s ? new Date(s * 1000).toISOString() : null);

// Try to find the Supabase user by metadata.user_id first, then by email.
async function resolveSupabaseUserId({ supabase, metadataUserId, email }) {
  if (metadataUserId) return metadataUserId;
  if (!email) return null;

  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const match = data?.users?.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (!data?.users?.length || data.users.length < 100) break;
  }
  return null;
}

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

  // Verify Stripe signature
  const sig = event.headers["stripe-signature"];
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
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

    let subscription, customerId, subscriptionId;
    let status = "unknown";
    let currentPeriodEnd = null;
    let planName = "Unknown";
    let customerEmail = null;
    let metadataUserId = null;

    if (evt.type === "checkout.session.completed") {
      const session = evt.data.object;
      customerId = session.customer;
      subscriptionId = session.subscription;
      customerEmail = session.customer_details?.email || null;

      if (subscriptionId) {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        status = subscription?.status || status;
        currentPeriodEnd = epochToISO(subscription?.current_period_end);
        const item = subscription?.items?.data?.[0];
        planName = priceToPlanName(item?.price);
      }
      if (customerId) {
        const customer = await stripe.customers.retrieve(customerId);
        metadataUserId = customer?.metadata?.user_id || null;
        customerEmail = customerEmail || customer?.email || null;
      }
    } else {
      subscription = evt.data.object;
      subscriptionId = subscription.id;
      customerId = subscription.customer;
      status = subscription?.status || status;
      currentPeriodEnd = epochToISO(subscription?.current_period_end);
      const item = subscription?.items?.data?.[0];
      planName = priceToPlanName(item?.price);

      if (customerId) {
        const customer = await stripe.customers.retrieve(customerId);
        metadataUserId = customer?.metadata?.user_id || null;
        customerEmail = customer?.email || null;
      }
    }

    const userId = await resolveSupabaseUserId({ supabase, metadataUserId, email: customerEmail });
    if (!userId) {
      console.log("⚠️ No user mapped", { customerId, customerEmail, metadataUserId });
      return { statusCode: 200, body: "no user mapped" };
    }

    const { error } = await supabase.from("subscriptions").upsert({
      user_id: userId,
      plan: planName,
      status,
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId || null,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return { statusCode: 500, body: err.message || "Server error" };
  }
};
