// File: netlify/functions/backfill-user-team-emails.js
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

    // Verify owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };

    // Find members missing email
    const { data: rows, error: mErr } = await supa
      .from("user_teams")
      .select("user_id, email")
      .eq("team_id", team_id);
    if (mErr) return { statusCode: 500, body: "Query failed" };

    let updated = 0;
    for (const r of rows || []) {
      if (!r.email) {
        try {
          const { data: ures } = await supa.auth.admin.getUserById(r.user_id);
          const email = ures?.user?.email || null;
          if (email) {
            await supa
              .from("user_teams")
              .update({ email })
              .eq("team_id", team_id)
              .eq("user_id", r.user_id);
            updated++;
          }
        } catch {
          // skip
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, updated }) };
  } catch (e) {
    console.error("backfill-user-team-emails error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
