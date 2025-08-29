// File: netlify/functions/stripe-webhook.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { path: "/.netlify/functions/stripe-webhook" };

function priceToPlanName(price) {
  // Prefer nickname; otherwise product id as fallback
  return price?.nickname || price?.product || "Unknown";
}

function epochToISO(s) {
  return s ? new Date(s * 1000).toISOString() : null;
}

async function findUserId({ supabase, email, metadataUserId }) {
  // 1) If Stripe customer had metadata.user_id (best case), use it
  if (metadataUserId) return metadataUserId;

  // 2) Fallback by email (works for hosted payment links)
  if (!email) return null;
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1, email });
  if (error) return null;
  const match = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return match?.id || null;
}

export async function handler(event) {
  // --- Init SDKs
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

  // --- Verify signature
  const sig = event.headers["stripe-signature"];
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  try {
    // We'll handle these events
    const interesting =
      evt.type === "checkout.session.completed" ||
      evt.type === "customer.subscription.created" ||
      evt.type === "customer.subscription.updated" ||
      evt.type === "customer.subscription.deleted";

    if (!interesting) return { statusCode: 200, body: "ignored" };

    let subscription;
    let customerId;
    let subscriptionId;
    let planName = "Unknown";
    let status = "unknown";
    let currentPeriodEnd = null;
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

      // fetch customer to read metadata.user_id
      const customer = await stripe.customers.retrieve(customerId);
      metadataUserId = customer?.metadata?.user_id || null;
    } else {
      // subscription.* event
      subscription = evt.data.object;
      subscriptionId = subscription.id;
      customerId = subscription.customer;
      status = subscription?.status || status;
      currentPeriodEnd = epochToISO(subscription?.current_period_end);
      const item = subscription?.items?.data?.[0];
      planName = priceToPlanName(item?.price);

      // get customer for email + metadata
      const customer = await stripe.customers.retrieve(customerId);
      customerEmail = customer?.email || null;
      metadataUserId = customer?.metadata?.user_id || null;
    }

    // Find Supabase user id
    const userId = await findUserId({ supabase, email: customerEmail, metadataUserId });
    if (!userId) {
      // We couldn't map this subscription to a Supabase user.
      // It's okay to return 200 to avoid retries; you can inspect logs in Netlify to see the email/customerId.
      console.log("No user_id resolved for customer:", { customerId, customerEmail, metadataUserId });
      return { statusCode: 200, body: "no user mapped" };
    }

    // Upsert into public.subscriptions
    const { error } = await supabase
      .from("subscriptions")
      .upsert({
        user_id: userId,
        plan: planName,
        status,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        current_period_end: currentPeriodEnd,
        updated_at: new Date().toISOString(),
      });

    if (error) throw error;

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("Webhook handler error:", err);
    return { statusCode: 500, body: err.message || "Server error" };
  }
}
