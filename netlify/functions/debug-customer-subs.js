// File: netlify/functions/debug-customer-subs.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const supa = makeSupaAdmin();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id, stripe_customer_id, stripe_subscription_id")
      .eq("id", team_id).single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };
    if (!team.stripe_customer_id)
      return { statusCode: 400, body: "Team is missing stripe_customer_id. Start a checkout first." };

    const subs = await stripe.subscriptions.list({
      customer: team.stripe_customer_id,
      status: "all",
      expand: ["data.items.data.price"],
      limit: 100,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        team_id,
        stripe_customer_id: team.stripe_customer_id,
        saved_subscription_id: team.stripe_subscription_id || null,
        subscriptions: (subs.data || []).map(s => ({
          id: s.id,
          status: s.status,
          created: s.created,
          items: (s.items?.data || []).map(it => ({
            price_id: it.price?.id,
            nickname: it.price?.nickname,
            product: it.price?.product,
            quantity: it.quantity,
          })),
        })),
      }),
    };
  } catch (e) {
    console.error("debug-customer-subs error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
