export async function startCall({ agentNumber, leadNumber, contactId = null }) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new Error("Not signed in");

  const r = await fetch("/.netlify/functions/call-start-v2", {  // ← v2
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
    // surface Telnyx message + what we sent
    throw new Error(j?.error || "Failed to start call");
  }
  return j;
}
