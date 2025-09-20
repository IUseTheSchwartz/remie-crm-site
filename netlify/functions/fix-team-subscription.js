// File: netlify/functions/fix-team-subscription.js
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

    const supa = makeSupaAdmin();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    // Load team and confirm owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id, stripe_customer_id, stripe_subscription_id")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };

    const customerId = team.stripe_customer_id;
    if (!customerId) {
      return {
        statusCode: 400,
        body: "Team is missing stripe_customer_id. Start a checkout first.",
      };
    }

    // List all subs for this customer (same Stripe env as your key)
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      expand: ["data.items.data.price"],
      limit: 100,
    });

    if (!subs?.data?.length) {
      return {
        statusCode: 400,
        body: `Customer ${customerId} has no subscriptions in this environment.`,
      };
    }

    // Prefer a sub that includes your seat price; else pick an active; else latest
    const seatPrice = process.env.STRIPE_PRICE_SEAT_50;
    let candidate =
      (seatPrice &&
        subs.data.find((s) => (s.items?.data || []).some((it) => it.price?.id === seatPrice))) ||
      null;

    if (!candidate) {
      const actives = subs.data
        .filter((s) => ["active", "trialing", "past_due"].includes(s.status))
        .sort((a, b) => (b.created || 0) - (a.created || 0));
      candidate = actives[0] || subs.data.sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    }

    if (!candidate) {
      return { statusCode: 400, body: "Could not determine a valid subscription for this customer." };
    }

    const newSubId = candidate.id;

    // If already correct, return info
    if (team.stripe_subscription_id === newSubId) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          message: "Stripe subscription already correct.",
          team_id,
          stripe_customer_id: customerId,
          stripe_subscription_id: newSubId,
        }),
      };
    }

    // Persist the corrected subscription id
    const { error: uErr } = await supa
      .from("teams")
      .update({ stripe_subscription_id: newSubId })
      .eq("id", team_id);
    if (uErr) return { statusCode: 500, body: `DB update failed: ${uErr.message}` };

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "Updated team.stripe_subscription_id",
        team_id,
        stripe_customer_id: customerId,
        new_subscription_id: newSubId,
        subscription_status: candidate.status,
        items: (candidate.items?.data || []).map((it) => ({
          price_id: it.price?.id,
          nickname: it.price?.nickname,
          product: it.price?.product,
          quantity: it.quantity,
        })),
      }),
    };
  } catch (e) {
    console.error("fix-team-subscription error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
