// File: netlify/functions/accept-invite.js
import { createClient } from "@supabase/supabase-js";

const BONUS_EMAIL = "jacobprieto@gmail.com";
const BONUS_SEATS = 10;

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

    // Who is accepting?
    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { token } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 400, body: "Missing token" };

    // 1) Look up invite
    const { data: invite, error: iErr } = await supa
      .from("team_invites")
      .select("id, team_id, expires_at, used_at")
      .eq("token", token)
      .single();

    if (iErr || !invite) return { statusCode: 404, body: "Invite not found" };
    if (invite.used_at) return { statusCode: 400, body: "Invite already used" };
    if (new Date(invite.expires_at).getTime() < Date.now())
      return { statusCode: 400, body: "Invite expired" };

    // 2) Get team (owner)
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id")
      .eq("id", invite.team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };

    // 3) Read paid seat counts (no bonus) from the view
    const { data: counts, error: cErr } = await supa
      .from("team_seat_counts")
      .select("seats_purchased, seats_used")
      .eq("team_id", invite.team_id)
      .single();
    if (cErr || !counts) {
      return { statusCode: 500, body: "Seat count unavailable" };
    }

    // 4) Determine if owner is the bonus email
    //    Try profiles.email first; if not present, fall back to auth.users
    let ownerEmail = null;

    // profiles table (public)
    try {
      const { data: prof } = await supa
        .from("profiles")
        .select("email")
        .eq("id", team.owner_id)
        .maybeSingle();
      ownerEmail = prof?.email || null;
    } catch {
      // ignore
    }

    // fallback via auth (service role)
    if (!ownerEmail) {
      try {
        const { data: authUser, error: aErr } = await supa.auth.admin.getUserById(team.owner_id);
        if (!aErr) ownerEmail = authUser?.user?.email || null;
      } catch {
        // ignore
      }
    }

    const isBonusTeam =
      ownerEmail && ownerEmail.toLowerCase() === BONUS_EMAIL.toLowerCase();

    // 5) Compute effective availability
    const paidPurchased = counts.seats_purchased || 0;
    const used = counts.seats_used || 0;
    const effectivePurchased = Math.max(paidPurchased + (isBonusTeam ? BONUS_SEATS : 0), 0);
    const effectiveAvailable = Math.max(effectivePurchased - used, 0);

    if (effectiveAvailable <= 0) {
      return {
        statusCode: 409,
        body: "No seats available. Ask the team owner to purchase more seats.",
      };
    }

    // 6) Upsert membership as active member
    const { error: mErr } = await supa.from("user_teams").upsert({
      user_id: userId,
      team_id: invite.team_id,
      role: "member",
      status: "active",
    });
    if (mErr) {
      return { statusCode: 500, body: "Failed to join team" };
    }

    // 7) Mark invite used
    await supa
      .from("team_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("id", invite.id);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, team_id: invite.team_id }),
    };
  } catch (e) {
    console.error("accept-invite error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
