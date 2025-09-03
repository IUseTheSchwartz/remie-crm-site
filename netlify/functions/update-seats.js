// File: netlify/functions/update-seats.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supa = makeSupaAdmin();

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id, seats } = JSON.parse(event.body || "{}");
    if (!team_id || typeof seats !== "number" || seats < 0) {
      return { statusCode: 400, body: "Invalid team_id or seats" };
    }

    // Confirm requester is the owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id, stripe_subscription_id, seats_purchased")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };

    // Don’t allow setting below seats already used
    const { data: counts } = await supa
      .from("team_seat_counts")
      .select("seats_used")
      .eq("team_id", team_id)
      .single();
    const used = counts?.seats_used || 0;
    if (seats < used) {
      return { statusCode: 400, body: `Cannot set seats below currently used (${used}). Remove members first.` };
    }

    // Update Stripe subscription item quantity to 'seats'
    const subId = team.stripe_subscription_id;
    if (!subId) return { statusCode: 400, body: "Missing subscription on team" };

    const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
    const seatItem = sub.items.data.find((it) => it.price.id === process.env.STRIPE_PRICE_SEAT_50);

    if (!seatItem) {
      // If missing, add item
      await stripe.subscriptions.update(subId, {
        items: [{ price: process.env.STRIPE_PRICE_SEAT_50, quantity: seats }],
        proration_behavior: "always_invoice",
      });
    } else {
      await stripe.subscriptionItems.update(seatItem.id, {
        quantity: seats,
        proration_behavior: "always_invoice",
      });
    }

    // Persist seats_purchased
    const { error: uErr } = await supa
      .from("teams")
      .update({ seats_purchased: seats })
      .eq("id", team_id);
    if (uErr) {
      console.warn("[update-seats] could not update seats_purchased in DB:", uErr.message);
    }

    // Return current counts
    const { data: after } = await supa
      .from("team_seat_counts")
      .select("*")
      .eq("team_id", team_id)
      .single();

    return { statusCode: 200, body: JSON.stringify({ ok: true, seatCounts: after }) };
  } catch (e) {
    console.error("update-seats error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
