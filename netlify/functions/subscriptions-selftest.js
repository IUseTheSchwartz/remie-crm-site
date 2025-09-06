// File: netlify/functions/subscriptions-selftest.js
import { createClient } from "@supabase/supabase-js";

const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  process.env.SUPABASE_URL && SERVICE_ROLE
    ? createClient(process.env.SUPABASE_URL, SERVICE_ROLE)
    : null;

export async function handler() {
  try {
    if (!supabase) {
      return {
        statusCode: 500,
        body: "Supabase service role not configured",
      };
    }

    // Minimal payload that matches the columns you said you have
    const nowIso = new Date().toISOString();
    const payload = {
      user_id: null, // can be null for the test
      id: "selftest_sub", // ok if you have an id col; if not, it will be ignored
      status: "active",
      plan_name: "SelfTest",
      stripe_customer_id: "selftest_cus",
      stripe_subscription_id: "selftest_sub",
      current_period_end: nowIso,
      updated_at: nowIso,
    };

    const { error } = await supabase
      .from("subscriptions")
      .upsert(payload, { onConflict: "stripe_subscription_id" });

    if (error) {
      return {
        statusCode: 500,
        body: `Upsert failed: ${error.message || error}`,
      };
    }

    return {
      statusCode: 200,
      body: "Self-test write OK. Check the subscriptions table for stripe_subscription_id=selftest_sub.",
    };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e?.message || e}` };
  }
}
