// File: netlify/functions/accept-invite.js
import { createClient } from "@supabase/supabase-js";

function supaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

// Helper to read auth context from headers (same pattern as your other fns)
function getUserIdFromEvent(event) {
  // Prefer explicit header set by your frontend helper
  const hdr = event.headers || {};
  return hdr["x-user-id"] || hdr["X-User-Id"] || null;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const supa = supaAdmin();
    const userId = getUserIdFromEvent(event);
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { token } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 400, body: "Missing token" };

    // 1) Load invite
    const { data: invite, error: iErr } = await supa
      .from("team_invites")
      .select("id, team_id, used_at, expires_at")
      .eq("token", token)
      .single();
    if (iErr || !invite) return { statusCode: 404, body: "Invite not found" };

    // 2) Validate
    if (invite.used_at) {
      // Already used — still tell them the team so the UI can route
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "Invite already used", team_id: invite.team_id }),
      };
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return { statusCode: 410, body: "Invite expired" };
    }

    // 3) Get user email from auth to store on user_teams (denormalized convenience)
    let userEmail = null;
    try {
      const { data: authUser, error: aErr } = await supa.auth.admin.getUserById(userId);
      if (!aErr) {
        userEmail = authUser?.user?.email || null;
      }
    } catch {
      /* no-op */
    }

    // 4) If already a member, short-circuit success
    const { data: existing, error: mErr } = await supa
      .from("user_teams")
      .select("user_id, status, role")
      .eq("team_id", invite.team_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!mErr && existing) {
      // Optionally ensure it’s marked active and email is set
      await supa
        .from("user_teams")
        .update({ status: "active", email: userEmail || existing.email || null })
        .eq("team_id", invite.team_id)
        .eq("user_id", userId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, team_id: invite.team_id }) };
    }

    // 5) Create membership as 'member', 'active' and store email
    const { error: insErr } = await supa
      .from("user_teams")
      .upsert(
        {
          team_id: invite.team_id,
          user_id: userId,
          role: "member",
          status: "active",
          email: userEmail, // <-- denormalized
          joined_at: new Date().toISOString(),
        },
        { onConflict: "team_id,user_id" }
      );
    if (insErr) {
      console.error("[accept-invite] upsert user_teams error:", insErr);
      return { statusCode: 500, body: "Failed to join team" };
    }

    // 6) Mark invite as used
    await supa
      .from("team_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("id", invite.id);

    // 7) Done
    return { statusCode: 200, body: JSON.stringify({ ok: true, team_id: invite.team_id }) };
  } catch (e) {
    console.error("accept-invite error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
