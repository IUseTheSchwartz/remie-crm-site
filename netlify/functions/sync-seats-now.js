// netlify/functions/sync-seats-now.js
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

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    const supa = makeSupaAdmin();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const { data: team, error } = await supa
      .from("teams")
      .select("id, owner_id, stripe_subscription_id")
      .eq("id", team_id)
      .single();
    if (error || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };
    if (!team.stripe_subscription_id) return { statusCode: 400, body: "Missing stripe subscription" };

    // Read live subscription
    const sub = await stripe.subscriptions.retrieve(team.stripe_subscription_id, { expand: ["items.data.price"] });
    const seatItem = sub.items.data.find((it) => it.price.id === process.env.STRIPE_PRICE_SEAT_50);
    const quantity = seatItem?.quantity || 0;

    // Persist seats_purchased
    await supa.from("teams").update({ seats_purchased: quantity }).eq("id", team_id);

    // Return current counts from the view
    const { data: counts } = await supa
      .from("team_seat_counts")
      .select("*")
      .eq("team_id", team_id)
      .single();

    return { statusCode: 200, body: JSON.stringify({ ok: true, seatCounts: counts }) };
  } catch (e) {
    console.error("sync-seats-now error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
