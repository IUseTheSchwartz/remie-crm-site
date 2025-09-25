// File: src/lib/numbers.js
import { supabase } from "./supabaseClient";

export async function getUid() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data?.user?.id || null;
}

export async function listMyNumbers() {
  const uid = await getUid();
  if (!uid) return [];
  const r = await fetch(`/.netlify/functions/numbers-list?agent_id=${encodeURIComponent(uid)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "Failed to fetch numbers");
  return j?.numbers || [];
}

export async function searchNumbersByAreaCode(npa, limit = 12) {
  const n = String(npa || "").replace(/\D+/g, "").slice(0, 3);
  if (n.length !== 3) throw new Error("Enter a 3-digit area code");
  const r = await fetch(`/.netlify/functions/telnyx-search-numbers?npa=${encodeURIComponent(n)}&limit=${limit}`);
  const j = await r.json();
  if (!r.ok || j?.ok === false) throw new Error(j?.error || "Number search failed");
  return (j?.data || []).map((x) => x.phone_number);
}

export async function purchaseNumber(phone_number) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new Error("Not signed in");
  const r = await fetch("/.netlify/functions/purchase-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number, agent_id: uid }),
  });
  const j = await r.json();
  if (!r.ok || j?.ok !== true) throw new Error(j?.error || "Failed to purchase number");
  return j.phone_number;
}
