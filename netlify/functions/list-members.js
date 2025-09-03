// File: netlify/functions/list-members.js
import { createClient } from "@supabase/supabase-js";

function supaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const supa = supaAdmin();

    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    // Verify the requester is the owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id, name")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };

    // Pull memberships only — include the denormalized email field
    const { data: mrows, error: mErr } = await supa
      .from("user_teams")
      .select("user_id, role, status, joined_at, email")
      .eq("team_id", team_id)
      .order("joined_at", { ascending: false });

    if (mErr) {
      console.error("[list-members] user_teams error:", mErr);
      return { statusCode: 500, body: "Failed to load members" };
    }

    // If email missing, backfill from auth (best-effort)
    const needsEmail = (mrows || []).filter((r) => !r.email);
    if (needsEmail.length > 0) {
      await Promise.all(
        needsEmail.map(async (r) => {
          try {
            const { data: ures, error: aErr } = await supa.auth.admin.getUserById(r.user_id);
            if (!aErr) {
              const email = ures?.user?.email || null;
              if (email) r.email = email;
            }
          } catch { /* no-op */ }
        })
      );
    }

    // Build members for the UI
    const members = (mrows || []).map((r) => ({
      user_id: r.user_id,
      role: r.role,
      status: r.status,
      joined_at: r.joined_at,
      profile: {
        id: null,
        full_name: null,
        email: r.email || null,
      },
      display_status: r.email ? r.status : "Setup agent profile",
    }));

    return { statusCode: 200, body: JSON.stringify({ members }) };
  } catch (e) {
    console.error("list-members error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
