// File: src/lib/calls.js
import { supabase } from "./supabaseClient";

/**
 * Start an AGENT-FIRST two-leg outbound call via Netlify function.
 */
export async function startCall({ agentNumber, leadNumber, contactId = null }) {
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
    agent_id: uid,
    user_id: uid,
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

  return json;
}

/**
 * Start a LEAD-FIRST call (Auto Dialer).
 */
export async function startLeadFirstCall({
  agentNumber,
  leadNumber,
  contactId = null,
  fromNumber = null,
  record = true,
  ringTimeout = 25,
  ringbackUrl = "",
  sessionId = null,
  press1Script = "",
  voicemailScript = "",
}) {
  const [{ data: auth }, { data: sess }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);

  const uid = auth?.user?.id;
  const token = sess?.session?.access_token || null;
  if (!uid || !token) throw new Error("Not signed in");

  const payload = {
    agent_number: agentNumber,
    lead_number: leadNumber,
    contact_id: contactId,
    ...(fromNumber ? { from_number: fromNumber } : {}),
    record,
    ring_timeout: ringTimeout,
    ringback_url: ringbackUrl,
    session_id: sessionId,
    // NEW: scripts
    press1_script: press1Script || "",
    voicemail_script: voicemailScript || "",
  };

  let res, json;
  try {
    res = await fetch("/.netlify/functions/dialer-lead-first-start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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

  return json;
}

/**
 * List recent call logs for the signed-in user.
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
