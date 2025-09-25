// src/lib/calls.js
import { supabase } from "./supabaseClient";

/**
 * Start an outbound call:
 *  - Calls the agent's phone first (agentNumber)
 *  - Uses local presence FROM one of the agent's DIDs
 *  - Serverless function uses call_control_app_id (numeric) under the hood
 */
export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new Error("Not signed in");

  const r = await fetch("/.netlify/functions/call-start-v2", { // ← v2 function
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_number: agentNumber,
      lead_number: leadNumber,
      agent_id: uid,
      user_id: uid,
      contact_id: contactId,
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error || "Failed to start call");
  }
  return j;
}

/**
 * List recent call logs for the signed-in user.
 * Assumes you have a `call_logs` table with RLS allowing user_id = auth.uid()
 */
export async function listMyCallLogs(limit = 100) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) return [];
  const { data: rows, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("user_id", uid)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return rows || [];
}
