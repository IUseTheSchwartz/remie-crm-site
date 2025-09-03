// File: netlify/functions/remove-member.js
import { supaAdmin, getUserIdFromEvent, syncStripeSeatsForTeam } from "./_shared.js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const { team_id, user_id } = JSON.parse(event.body || "{}");
    if (!team_id || !user_id) return { statusCode: 400, body: "Missing team_id or user_id" };

    const supa = supaAdmin();
    const requesterId = getUserIdFromEvent(event);

    // Check ownership
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("owner_id")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== requesterId) return { statusCode: 403, body: "Not team owner" };

    // Prevent removing owner
    if (user_id === requesterId) return { statusCode: 400, body: "Owner cannot be removed" };

    // Soft-remove member
    const { error: rErr } = await supa
      .from("user_teams")
      .update({ status: "removed" })
      .eq("team_id", team_id)
      .eq("user_id", user_id);
    if (rErr) throw rErr;

    // Update Stripe seat count
    await syncStripeSeatsForTeam(supa, team_id);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("remove-member error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
