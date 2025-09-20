// File: netlify/functions/update-seats.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

async function resolveTeamAndAssertOwner(supa, userId, team_id) {
  const { data: team, error: tErr } = await supa
    .from("teams")
    .select("id, owner_id, stripe_customer_id, stripe_subscription_id, seats_purchased")
    .eq("id", team_id)
    .single();

  if (tErr || !team) return { error: { code: 404, msg: "Team not found" } };
  if (team.owner_id !== userId) return { error: { code: 403, msg: "Not team owner" } };
  if (!team.stripe_customer_id)
    return { error: { code: 400, msg: "Team is missing stripe_customer_id. Start a checkout first." } };
  return { team };
}

async function findBestSubscriptionForCustomer(stripe, customerId, seatPriceId) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    expand: ["data.items.data.price"],
    limit: 100,
  });
  if (!subs?.data?.length) return null;

  if (seatPriceId) {
    const withSeat = subs.data.find(s =>
      (s.items?.data || []).some(it => it.price?.id === seatPriceId)
    );
    if (withSeat) return withSeat;
  }

  const actives = subs.data
    .filter(s => ["active", "trialing", "past_due"].includes(s.status))
    .sort((a,b) => (b.created||0)-(a.created||0));
  return actives[0] || subs.data.sort((a,b)=> (b.created||0)-(a.created||0))[0];
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const supa = makeSupaAdmin();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id, seats } = JSON.parse(event.body || "{}");
    if (!team_id || typeof seats !== "number" || seats < 0)
      return { statusCode: 400, body: "Invalid team_id or seats" };

    const { team, error: teamErr } = await resolveTeamAndAssertOwner(supa, userId, team_id);
    if (teamErr) return { statusCode: teamErr.code, body: teamErr.msg };

    const { data: counts } = await supa
      .from("team_seat_counts")
      .select("seats_used")
      .eq("team_id", team_id)
      .single();
    const used = counts?.seats_used ?? 0;
    if (seats < used) return { statusCode: 400, body: `Seats cannot be set below current usage (${used}).` };

    const seatPriceId = process.env.STRIPE_PRICE_SEAT_50;
    if (!seatPriceId) return { statusCode: 500, body: "Server misconfiguration: STRIPE_PRICE_SEAT_50 is not set." };

    // ---- Ensure correct subscription for this customer (auto-correct if needed)
    const tryLoad = async (id) => {
      if (!id) return null;
      try {
        const sub = await stripe.subscriptions.retrieve(id, { expand: ["items.data.price"] });
        if (String(sub.customer) !== String(team.stripe_customer_id)) return null;
        return sub;
      } catch { return null; }
    };

    let subscription = await tryLoad(team.stripe_subscription_id);
    if (!subscription) {
      const best = await findBestSubscriptionForCustomer(stripe, team.stripe_customer_id, seatPriceId);
      if (!best) {
        return { statusCode: 400, body: `Customer ${team.stripe_customer_id} has no subscriptions in this Stripe environment.` };
      }
      subscription = best;

      if (team.stripe_subscription_id !== best.id) {
        const { error: uErr } = await supa
          .from("teams")
          .update({ stripe_subscription_id: best.id })
          .eq("id", team_id);
        if (uErr) console.warn("[update-seats] could not persist corrected sub id:", uErr.message);
      }
    }

    const seatItem = (subscription.items?.data || []).find(it => it?.price?.id === seatPriceId);

    try {
      if (!seatItem) {
        await stripe.subscriptions.update(subscription.id, {
          items: [{ price: seatPriceId, quantity: seats }],
          proration_behavior: "always_invoice",
        });
      } else {
        await stripe.subscriptionItems.update(seatItem.id, {
          quantity: seats,
          proration_behavior: "always_invoice",
        });
      }
    } catch (e) {
      console.error("[update-seats] seat item update failed:", e);
      return { statusCode: 400, body: `Stripe error: ${e.message || "update failed"}` };
    }

    const { error: dbErr } = await supa
      .from("teams")
      .update({ seats_purchased: seats })
      .eq("id", team_id);
    if (dbErr) console.warn("[update-seats] DB update warning:", dbErr.message);

    const { data: after } = await supa
      .from("team_seat_counts")
      .select("*")
      .eq("team_id", team_id)
      .single();

    return { statusCode: 200, body: JSON.stringify({ ok: true, seatCounts: after }) };
  } catch (e) {
    console.error("update-seats error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
