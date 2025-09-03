// File: netlify/functions/leave-team.js
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

    // Auth context (sent by your frontend helper)
    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { team_id } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    // Get membership
    const { data: membership, error: mErr } = await supa
      .from("user_teams")
      .select("team_id, user_id, role, status")
      .eq("team_id", team_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (mErr) {
      console.error("[leave-team] membership lookup error:", mErr);
      return { statusCode: 500, body: "Membership lookup failed" };
    }
    if (!membership) {
      return { statusCode: 404, body: "You are not on this team" };
    }

    // Disallow owner leaving via this endpoint
    if (membership.role === "owner") {
      return {
        statusCode: 403,
        body: "Owners cannot leave their own team. Transfer ownership or delete the team.",
      };
    }

    // Remove membership (hard delete) or set status = 'left'
    const { error: delErr } = await supa
      .from("user_teams")
      .delete()
      .eq("team_id", team_id)
      .eq("user_id", userId);

    if (delErr) {
      console.error("[leave-team] delete failed:", delErr);
      return { statusCode: 500, body: "Failed to leave team" };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("leave-team error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
