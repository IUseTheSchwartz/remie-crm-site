// src/lib/calls.js
import { supabase } from "./supabaseClient";

export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new Error("Not signed in");

  const r = await fetch("/.netlify/functions/call-start", {
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
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j?.error || "Failed to start call");
  return j;
}

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
