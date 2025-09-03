// File: netlify/functions/accept-invite.js
import { supaAdmin, getUserIdFromEvent, syncStripeSeatsForTeam } from "./_shared.js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const { token } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 400, body: "Missing token" };

    const supa = supaAdmin();
    const userId = getUserIdFromEvent(event);

    const { data: invite, error: iErr } = await supa
      .from("team_invites")
      .select("id, team_id, expires_at, used_at")
      .eq("token", token)
      .single();
    if (iErr || !invite) return { statusCode: 404, body: "Invite not found" };

    if (invite.used_at) return { statusCode: 400, body: "Invite already used" };
    if (new Date(invite.expires_at).getTime() < Date.now())
      return { statusCode: 400, body: "Invite expired" };

    // Upsert member
    await supa.from("user_teams").upsert({
      user_id: userId,
      team_id: invite.team_id,
      role: "member",
      status: "active",
    });

    // Mark invite used
    await supa
      .from("team_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("id", invite.id);

    // BILLING: sync seats (quantity = active members)
    await syncStripeSeatsForTeam(supa, invite.team_id);

    return { statusCode: 200, body: JSON.stringify({ ok: true, team_id: invite.team_id }) };
  } catch (e) {
    console.error("accept-invite error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
