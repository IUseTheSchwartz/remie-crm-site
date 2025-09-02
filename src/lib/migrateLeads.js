// File: src/lib/migrateLeads.js
import { supabase } from "./supabaseClient";
import { loadLeads } from "./storage";

/**
 * Migrate ONLY locally stored SOLD leads to Supabase for the provided userId.
 * - Skips duplicates (idempotent).
 * - Logs debug messages for each stage (check DevTools console).
 */
export async function migrateSoldLeads(userId) {
  if (!userId) throw new Error("Not logged in");

  const localAll = loadLeads() || [];
  const localSold = localAll.filter((p) => p?.status === "sold");
  console.debug("[migrateLeads] total local:", localAll.length, "sold:", localSold.length);

  if (!localSold.length) {
    return { scanned: localAll.length, soldFound: 0, inserted: 0, skipped: 0, note: "no local SOLD" };
  }

  // 1) Check what’s already in Supabase
  let existingRows = [];
  try {
    console.debug("[migrateLeads] checking Supabase for existing SOLD leads…");
    const { data, error } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "sold");
    if (error) throw error;
    existingRows = data || [];
    console.debug("[migrateLeads] found existing:", existingRows.length);
  } catch (e) {
    console.error("[migrateLeads] select failed:", e);
    throw new Error("Supabase select failed: " + (e?.message || e));
  }

  const existingIds = new Set(existingRows.map((r) => r.id));
  const toInsert = localSold.filter((p) => !existingIds.has(p.id));
  console.debug("[migrateLeads] to insert:", toInsert.length);

  if (!toInsert.length) {
    return {
      scanned: localAll.length,
      soldFound: localSold.length,
      inserted: 0,
      skipped: localSold.length,
      note: "all already present",
    };
  }

  // 2) Upsert new ones
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
    sold: p.sold || null,
    updated_at: new Date().toISOString(),
  }));

  try {
    console.debug("[migrateLeads] upserting rows:", rows.length);
    const { error } = await supabase.from("leads").upsert(rows);
    if (error) throw error;
    console.debug("[migrateLeads] upsert done");
  } catch (e) {
    console.error("[migrateLeads] upsert failed:", e);
    throw new Error("Supabase upsert failed: " + (e?.message || e));
  }

  return {
    scanned: localAll.length,
    soldFound: localSold.length,
    inserted: rows.length,
    skipped: localSold.length - rows.length,
  };
}
