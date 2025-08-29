// File: netlify/functions/cancel-subscription.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  try {
    const { user_id } = JSON.parse(event.body);

    // Supabase admin client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // Find subscription for this user
    const { data, error } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", user_id)
      .single();

    if (error || !data) {
      return { statusCode: 404, body: "Subscription not found" };
    }

    const subId = data.stripe_subscription_id;

    // Cancel in Stripe
    const canceled = await stripe.subscriptions.update(subId, {
      cancel_at_period_end: true,
    });

    // Update Supabase
    await supabase
      .from("subscriptions")
      .update({ status: "canceled" })
      .eq("user_id", user_id);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, canceled }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};
