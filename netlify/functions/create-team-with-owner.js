// File: netlify/functions/create-team-with-owner.js
import { createClient } from "@supabase/supabase-js";

function makeSupaAdmin() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const userId = event.headers["x-user-id"];
    if (!userId) return { statusCode: 401, body: "Not authenticated" };

    const { name } = JSON.parse(event.body || "{}");
    const supa = makeSupaAdmin();

    // 1) Create team with the caller as the owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .insert([{ name: name || "New Team", owner_id: userId }])
      .select("*")
      .single();

    if (tErr || !team) {
      return { statusCode: 500, body: `Create team failed: ${tErr?.message || "unknown"}` };
    }

    // 2) Ensure owner membership exists (idempotent)
    //    Adjust onConflict columns if your table uses a different unique key.
    const { error: mErr } = await supa
      .from("team_members")
      .upsert(
        [{ team_id: team.id, user_id: userId, role: "owner" }],
        { onConflict: "team_id,user_id" }
      );

    if (mErr) {
      return { statusCode: 500, body: `Join as owner failed: ${mErr.message}` };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, team }) };
  } catch (e) {
    console.error("create-team-with-owner error:", e);
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
