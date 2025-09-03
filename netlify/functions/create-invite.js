// File: netlify/functions/create-invite.js
import crypto from "crypto";
import { supaAdmin, getUserIdFromEvent } from "./_shared.js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const { team_id, email } = JSON.parse(event.body || "{}");
    if (!team_id) return { statusCode: 400, body: "Missing team_id" };

    const supa = supaAdmin();
    const userId = getUserIdFromEvent(event);

    // verify requester is owner
    const { data: team, error: tErr } = await supa
      .from("teams")
      .select("id, owner_id, name")
      .eq("id", team_id)
      .single();
    if (tErr || !team) return { statusCode: 404, body: "Team not found" };
    if (team.owner_id !== userId) return { statusCode: 403, body: "Not team owner" };

    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const { data: invite, error: iErr } = await supa
      .from("team_invites")
      .insert({ team_id, email: email || null, token, expires_at: expiresAt })
      .select("*")
      .single();
    if (iErr) throw iErr;

    // Frontend route you’ll handle:
    const acceptUrl = `${process.env.PUBLIC_APP_URL || "https://your-app.com"}/accept-invite?token=${token}`;
    return { statusCode: 200, body: JSON.stringify({ invite, acceptUrl }) };
  } catch (e) {
    console.error("create-invite error:", e);
    return { statusCode: 500, body: "Server error" };
  }
}
