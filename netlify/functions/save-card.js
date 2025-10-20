// File: netlify/functions/save-card.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE
  );

  try {
    const { userId } = JSON.parse(event.body);
    if (!userId) throw new Error("Missing userId");

    // 1. Find Stripe customer or create one
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    let customerId = sub?.stripe_customer_id;
    if (!customerId) {
      const user = await supabase.auth.admin.getUserById(userId);
      const email = user?.data?.user?.email;
      const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });
      customerId = customer.id;

      await supabase.from("subscriptions").upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        created_at: new Date().toISOString(),
      });
    }

    // 2. Create SetupIntent for card saving
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ clientSecret: setupIntent.client_secret }),
    };
  } catch (e) {
    console.error("save-card error:", e);
    return { statusCode: 500, body: e.message };
  }
};
