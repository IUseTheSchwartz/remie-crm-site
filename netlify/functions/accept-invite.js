// File: netlify/functions/accept-invite.js
// (only showing the important differences from your current version)
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

    const supa = makeSupaAdmin();
    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { token } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 400, body: "Missing token" };

    const { data: invite, error: iErr } = await supa
      .from("team_invites")
      .select("id, team_id, expires_at, used_at")
      .eq("token", token)
      .single();
    if (iErr || !invite) return { statusCode: 404, body: "Invite not found" };

    if (invite.used_at) return { statusCode: 400, body: "Invite already used" };
    if (new Date(invite.expires_at).getTime() < Date.now())
      return { statusCode: 400, body: "Invite expired" };

    // Check capacity BEFORE adding member
    const { data: counts } = await supa
      .from("team_seat_counts")
      .select("seats_purchased, seats_used, seats_available")
      .eq("team_id", invite.team_id)
      .single();

    if (!counts || counts.seats_available <= 0) {
      return {
        statusCode: 409,
        body: "No seats available. Ask the team owner to purchase more seats.",
      };
    }

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

    // Done — seats_used will reflect the new member via the view
    return { statusCode: 200, body: JSON.stringify({ ok: true, team_id: invite.team_id }) };
  } catch (e) {
    console.error("accept-invite error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
