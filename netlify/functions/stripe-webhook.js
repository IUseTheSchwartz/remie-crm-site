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
  // ✅ Ensure the service-role key env var works no matter how you named it
  const SUPABASE_SERVICE_ROLE =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  // ✅ Handle Netlify base64 bodies
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

    let subscription, customerId, subscriptionId;
    let status = "unknown";
    let currentPeriodEnd = null;
    let planName = "Unknown";
    let customerEmail = null;
    let metadataUserId = null;

    if (evt.type === "checkout.session.completed") {
      const session = evt.data.object;
      customerId = session.customer;
      customerEmail = session.customer_details?.email || session.customer_email || null;
      const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
      metadataUserId = customer?.metadata?.user_id || session?.metadata?.user_id || null;

      // Get active subscription for this customer
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 1 });
      subscription = subs.data?.[0] || null;
    } else {
      subscription = evt.data.object;
      subscriptionId = subscription.id;
      customerId = subscription.customer;
      currentPeriodEnd = epochToISO(subscription.current_period_end);
      status = (subscription.status || "unknown").toLowerCase();
      planName = priceToPlanName(subscription.items?.data?.[0]?.price);
      // Try to get email/user from customer
      const cust = customerId ? await stripe.customers.retrieve(customerId) : null;
      customerEmail = cust?.email || null;
      metadataUserId = cust?.metadata?.user_id || subscription?.metadata?.user_id || null;
    }

    if (subscription) {
      subscriptionId = subscription.id;
      currentPeriodEnd = epochToISO(subscription.current_period_end);
      status = (subscription.status || "unknown").toLowerCase();
      planName = priceToPlanName(subscription.items?.data?.[0]?.price);
    }

    const userId = await resolveSupabaseUserId({ supabase, metadataUserId, email: customerEmail });
    if (!userId) {
      console.log("⚠️ No user mapped", { customerId, customerEmail, metadataUserId });
      return { statusCode: 200, body: "no user mapped" };
    }

    // ✅ Use correct column names; keep history (no ON CONFLICT)
    const { error } = await supabase.from("subscriptions").insert({
      user_id: userId,
      plan_name: planName,
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
