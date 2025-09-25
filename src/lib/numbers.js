// File: src/lib/numbers.js
import { supabase } from "./supabaseClient";

/** Get current auth user id */
export async function getUid() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data?.user?.id || null;
}

/** List numbers the current user owns (from agent_numbers) */
export async function listMyNumbers() {
  const uid = await getUid();
  if (!uid) return [];
  const r = await fetch(`/.netlify/functions/numbers-list?agent_id=${encodeURIComponent(uid)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "Failed to fetch numbers");
  return j?.numbers || [];
}

/** Search Telnyx inventory by area code (NPA) */
export async function searchNumbersByAreaCode(npa, limit = 12) {
  const n = String(npa || "").replace(/\D+/g, "").slice(0, 3);
  if (n.length !== 3) throw new Error("Enter a 3-digit area code");
  const r = await fetch(
    `/.netlify/functions/telnyx-search-numbers?npa=${encodeURIComponent(n)}&limit=${limit}`
  );
  const j = await r.json();
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error || "Number search failed");
  }
  return (j?.data || []).map((x) => x.phone_number);
}

/** Purchase a number for the current user (orders + assigns + saves to agent_numbers) */
export async function purchaseNumber(phone_number, { isFree = false } = {}) {
  const uid = await getUid();
  if (!uid) throw new Error("Not signed in");
  const r = await fetch("/.netlify/functions/telnyx-order-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number, agent_id: uid, is_free: !!isFree }),
  });
  const j = await r.json();
  if (!r.ok || j?.ok !== true) {
    throw new Error(j?.error || "Failed to purchase number");
  }
  return j.phone_number;
}

/** (Optional) Claim an already-owned Telnyx DID into agent_numbers */
export async function claimExistingNumber(phone_number) {
  const uid = await getUid();
  if (!uid) throw new Error("Not signed in");
  const r = await fetch("/.netlify/functions/claim-existing-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number, agent_id: uid }),
  });
  const j = await r.json();
  if (!r.ok || j?.ok !== true) {
    throw new Error(j?.error || "Failed to claim number");
  }
  return j.phone_number;
}
