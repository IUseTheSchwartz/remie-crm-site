// File: src/lib/calls.js
import { supabase } from "../lib/supabaseClient";

/**
 * Start a two-leg outbound call:
 * - We call the AGENT first (agent_number / your cell).
 * - When answered, your Call Control app can bridge to the lead if desired (future).
 *
 * Server function expects: { agent_id, agent_number, lead_number, contact_id? }
 */
export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  // get current user id for agent_id
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) throw new Error("Not signed in");

  const res = await fetch("/.netlify/functions/call-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: userId,
      agent_number: agentNumber, // E.164 (+1...) — DialerPage already normalizes
      lead_number: leadNumber,   // E.164
      contact_id: contactId || null,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    // show Telnyx detail when available
    const msg =
      json?.error ||
      json?.errors?.[0]?.detail ||
      "Failed to start call";
    throw new Error(msg);
  }
  return json; // { ok: true, call_leg_id: ... }
}
