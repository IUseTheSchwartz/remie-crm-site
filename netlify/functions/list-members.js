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

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    // Ensure requester is the owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id")
      .eq("id", team_id)
      .single();

    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) {
      return { statusCode: 403, body: "Not team owner" };
    }

    // LEFT join to profiles (no !inner), so members without a profile row still appear.
    const { data: rows, error: mErr } = await supa
      .from("user_teams")
      .select(`
        user_id,
        role,
        status,
        joined_at,
        profiles ( id, full_name, email )
      `)
      .eq("team_id", team_id)
      .in("status", ["active", "invited"])
      .order("joined_at", { ascending: false });

    if (mErr) {
      console.error("[list-members] query error:", mErr);
      return { statusCode: 500, body: "Failed to load members" };
    }

    let members = (rows || []).map((r) => ({
      user_id: r.user_id,
      role: r.role,
      status: r.status,
      joined_at: r.joined_at,
      profile: {
        id: r.profiles?.id ?? null,
        full_name: r.profiles?.full_name ?? null,
        email: r.profiles?.email ?? null,
      },
    }));

    // Backfill missing emails from auth if profiles is null or email is empty
    const needsAuthLookup = members.filter(
      (m) => !m.profile?.email || !m.profile?.id
    );

    if (needsAuthLookup.length > 0) {
      await Promise.all(
        needsAuthLookup.map(async (m) => {
          try {
            const { data: userRes, error: aErr } = await supa.auth.admin.getUserById(m.user_id);
            if (!aErr) {
              const email = userRes?.user?.email || null;
              if (email) {
                m.profile = {
                  id: m.profile?.id ?? null,
                  full_name: m.profile?.full_name ?? null,
                  email,
                };
              }
            }
          } catch {
            // ignore
          }
        })
      );
    }

    return { statusCode: 200, body: JSON.stringify({ members }) };
  } catch (e) {
    console.error("list-members error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
