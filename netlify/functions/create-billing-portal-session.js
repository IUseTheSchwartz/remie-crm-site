// netlify/functions/create-billing-portal-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST")
      return { statusCode: 405, body: "Method not allowed" };

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id, return_url } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    const supa = makeSupaAdmin();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const { data: team, error } = await supa
      .from("teams")
      .select("owner_id, stripe_customer_id")
      .eq("id", team_id)
      .single();
    if (error || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };
    if (!team.stripe_customer_id) return { statusCode: 400, body: "Team missing stripe customer" };

    const session = await stripe.billingPortal.sessions.create({
      customer: team.stripe_customer_id,
      return_url:
        return_url ||
        `${process.env.PUBLIC_APP_URL || "https://your-app.com"}/app/team/manage/${team_id}`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    console.error("create-billing-portal-session error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
