// File: netlify/functions/backfill-subscriptions-userid.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, SERVICE_ROLE);

export async function handler() {
  try {
    const { data: rows, error } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .is("user_id", null)
      .not("stripe_customer_id", "is", null)
      .limit(500);
    if (error) throw error;

    let updated = 0;
    for (const r of rows || []) {
      const cus = await stripe.customers.retrieve(r.stripe_customer_id);
      const uid = cus?.metadata?.user_id || null;
      if (!uid) continue;

      const { error: uErr } = await supabase
        .from("subscriptions")
        .update({ user_id: uid, updated_at: new Date().toISOString() })
        .eq("stripe_customer_id", r.stripe_customer_id)
        .is("user_id", null);
      if (!uErr) updated++;
    }
    return { statusCode: 200, body: `Backfilled user_id on ${updated} rows` };
  } catch (e) {
    return { statusCode: 500, body: `Error: ${e?.message || e}` };
  }
}
