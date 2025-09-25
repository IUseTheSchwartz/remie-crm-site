// src/lib/numbers.js
import { supabase } from "./supabaseClient";

export async function getUid() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id || null;
}

export async function listMyNumbers() {
  const uid = await getUid();
  if (!uid) return [];
  const r = await fetch(`/.netlify/functions/numbers-list?agent_id=${encodeURIComponent(uid)}`);
  const j = await r.json();
  return j?.numbers || [];
}

export async function searchNumbersByAreaCode(npa, limit = 10) {
  const r = await fetch(`/.netlify/functions/telnyx-search-numbers?npa=${encodeURIComponent(npa)}&limit=${limit}`);
  const j = await r.json();
  return (j?.data || []).map((x) => x.phone_number);
}

export async function purchaseNumber(phone_number, { isFree = false } = {}) {
  const uid = await getUid();
  const r = await fetch("/.netlify/functions/telnyx-order-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number, agent_id: uid, is_free: isFree }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j?.error || "Failed to purchase number");
  return j.phone_number;
}
