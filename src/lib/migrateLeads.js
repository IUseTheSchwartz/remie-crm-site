// File: src/lib/migrateLeads.js
import { supabase } from "./supabaseClient";
import { loadLeads } from "./storage";

/**
 * Migrate ONLY locally stored SOLD leads to Supabase for the provided userId.
 * Idempotent: skips IDs that already exist for that user.
 */
export async function migrateSoldLeads(userId) {
  if (!userId) throw new Error("Not logged in");

  const localAll = loadLeads() || [];
  const localSold = localAll.filter((p) => p?.status === "sold");
  if (!localSold.length) {
    return { scanned: localAll.length, soldFound: 0, inserted: 0, skipped: 0 };
  }

  // existing SOLD ids for this user
  const { data: existing, error: exErr } = await supabase
    .from("leads")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "sold");
  if (exErr) throw exErr;

  const existingIds = new Set((existing || []).map((r) => r.id));
  const toInsert = localSold.filter((p) => !existingIds.has(p.id));

  if (!toInsert.length) {
    return { scanned: localAll.length, soldFound: localSold.length, inserted: 0, skipped: localSold.length };
  }

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

  const { error } = await supabase.from("leads").upsert(rows);
  if (error) throw error;

  return {
    scanned: localAll.length,
    soldFound: localSold.length,
    inserted: rows.length,
    skipped: localSold.length - rows.length,
  };
}
