import { supabase } from "./supabaseClient";

/**
 * Start an AGENT-FIRST two-leg outbound call via Netlify function.
 * - Server selects best caller ID from agent's owned DIDs
 * - Agent phone rings FIRST; on agent answer, webhook dials the LEAD and bridges on human
 * - Returns { ok: true, call_leg_id } on success
 */
export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  // Ensure user is signed in; server uses agent_id to pick caller ID
  const [{ data: auth }, { data: sess }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);

  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not signed in");

  const token = sess?.session?.access_token || null;

  const payload = {
    agent_number: agentNumber,   // E.164 (+1XXXXXXXXXX) — we call this FIRST
    lead_number: leadNumber,     // E.164 — called by webhook AFTER agent answers
    agent_id: uid,
    user_id: uid,                // kept for back-compat
    contact_id: contactId ?? null,
  };

  let res, json;
  try {
    res = await fetch("/.netlify/functions/call-start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(e?.message || "Network error while starting call");
  }

  try {
    json = await res.json();
  } catch {
    json = {};
  }

  if (!res.ok || json?.ok === false) {
    const msg =
      json?.error ||
      json?.errors?.[0]?.detail ||
      json?.message ||
      `Failed to start call (${res.status})`;
    throw new Error(msg);
  }

  // { ok: true, call_leg_id }
  return json;
}

/**
 * Start a LEAD-FIRST call (Auto Dialer).
 * - Calls the LEAD first (Leg A)
 * - Your telnyx-voice-webhook.js (lead_first branch) will dial the AGENT on lead answer and bridge
 * Returns: { ok:true, call_leg_id, call_session_id?, contact_id }
 */
export async function startLeadFirstCall({
  agentNumber,
  leadNumber,
  contactId = null,
  fromNumber,
  record = true,
  ringTimeout = 25,
  ringbackUrl = "",
  sessionId = null,
}) {
  const [{ data: auth }, { data: sess }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);

  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not signed in");
  const token = sess?.session?.access_token || null;

  const payload = {
    agent_number: agentNumber,
    lead_number: leadNumber,
    contact_id: contactId,
    from_number: fromNumber,      // REQUIRED caller ID to present
    record,
    ring_timeout: ringTimeout,
    ringback_url: ringbackUrl,
    session_id: sessionId,
  };

  let res, json;
  try {
    res = await fetch("/.netlify/functions/dialer-lead-first-start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(e?.message || "Network error while starting lead-first call");
  }

  try {
    json = await res.json();
  } catch {
    json = {};
  }

  if (!res.ok || json?.ok === false) {
    const msg =
      json?.error ||
      json?.errors?.[0]?.detail ||
      json?.message ||
      `Failed to start lead-first call (${res.status})`;
    throw new Error(msg);
  }

  return json; // { ok:true, call_leg_id, call_session_id?, contact_id }
}

/**
 * List recent call logs for the signed-in user.
 * Expects a `call_logs` table with RLS to auth.uid().
 * Typical columns used elsewhere: to_number, from_number, status, started_at, duration_seconds, recording_url
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
