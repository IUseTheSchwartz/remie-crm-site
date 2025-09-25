// File: src/lib/calls.js
import { supabase } from "./supabaseClient";

/**
 * Call the Netlify function that starts a two-leg outbound call.
 * - Server picks the best caller ID from agent's owned DIDs
 * - Uses Telnyx Call Control Application via `connection_id` (server-side)
 * - Returns { ok: true, call_leg_id } on success
 */
export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  // Ensure user is signed in; server needs agent_id to select the caller ID from agent_numbers
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not signed in");

  // POST to your Netlify function (/.netlify/functions/call-start)
  let res, json;
  try {
    res = await fetch("/.netlify/functions/call-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_number: agentNumber,   // E.164 (+1...)
        lead_number: leadNumber,     // E.164
        agent_id: uid,
        user_id: uid,                // kept for back-compat
        contact_id: contactId ?? null,
      }),
    });
  } catch (e) {
    // Network or CORS issue
    throw new Error(e?.message || "Network error while starting call");
  }

  try {
    json = await res.json();
  } catch {
    json = {};
  }

  // Surface Telnyx detail when available
  if (!res.ok || json?.ok === false) {
    const msg =
      json?.error ||
      json?.errors?.[0]?.detail ||
      "Failed to start call";
    throw new Error(msg);
  }

  return json; // { ok: true, call_leg_id: ... }
}

/**
 * List recent call logs for the signed-in user.
 * Expects a `call_logs` table with RLS to auth.uid().
 * Columns used by DialerPage: to_number, from_number, status, started_at, duration_seconds, recording_url
 */
export async function listMyCallLogs(limit = 100) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return [];

  const { data: rows, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("user_id", uid)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message || "Failed to load call logs");
  return rows || [];
}
