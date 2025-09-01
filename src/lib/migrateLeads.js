// File: src/lib/migrateLeads.js
import { supabase } from "./supabaseClient";
import { loadLeads } from "./storage";

/**
 * Migrate ONLY locally stored SOLD leads to Supabase for the provided userId.
 * - Idempotent: skips IDs already present for that user.
 * - Throws helpful errors (so the UI can show them).
 */
export async function migrateSoldLeads(userId) {
  if (!userId) throw new Error("Not logged in");

  const localAll = loadLeads() || [];
  const localSold = localAll.filter((p) => p?.status === "sold");
  if (!localSold.length) {
    return { scanned: localAll.length, soldFound: 0, inserted: 0, skipped: 0, note: "no local SOLD" };
  }

  // 1) Find already-present SOLD leads to avoid duplicates
  let existingRows = [];
  try {
    const { data, error } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "sold");
    if (error) throw error;
    existingRows = data || [];
  } catch (e) {
    throw new Error("Supabase select failed: " + (e?.message || e));
  }

  const existingIds = new Set(existingRows.map((r) => r.id));
  const toInsert = localSold.filter((p) => !existingIds.has(p.id));

  if (!toInsert.length) {
    return {
      scanned: localAll.length,
      soldFound: localSold.length,
      inserted: 0,
      skipped: localSold.length,
      note: "all already present",
    };
  }

  // 2) Upsert only the new ones
  const rows = toInsert.map((p) => ({
    id: p.id,
    user_id: userId,
    name: p.name || "",
    phone: p.phone || "",
    email: p.email || "",
    status: "sold",
    notes: p.notes || "",
    dob: p.dob || null,
    state: p.state || "",
    beneficiary: p.beneficiary || "",
    beneficiary_name: p.beneficiary_name || "",
    company: p.company || "",
    gender: p.gender || "",
    sold: p.sold || null, // { carrier, faceAmount, premium, monthlyPayment, policyNumber, effectiveDate/startDate, notes, address{street,city,state,zip} }
    updated_at: new Date().toISOString(),
  }));

  try {
    const { error } = await supabase.from("leads").upsert(rows);
    if (error) throw error;
  } catch (e) {
    // Common cause: missing table/columns or RLS policy
    throw new Error("Supabase upsert failed (check RLS & schema): " + (e?.message || e));
  }

  return {
    scanned: localAll.length,
    soldFound: localSold.length,
    inserted: rows.length,
    skipped: localSold.length - rows.length,
  };
}
