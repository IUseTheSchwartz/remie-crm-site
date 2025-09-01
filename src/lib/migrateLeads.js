// File: src/lib/migrateLeads.js
import { supabase } from "./supabaseClient";
import { loadLeads } from "./storage";

/**
 * Migrate ONLY locally stored SOLD leads to Supabase.
 * Idempotent: skips IDs that already exist in Supabase.
 * After this, new SOLD leads are written to Supabase by repoMarkSold(), so no re-migration needed.
 */
export async function migrateSoldLeads() {
  // must be logged in so rows get your user_id
  const { data: s, error: sessErr } = await supabase.auth.getSession();
  if (sessErr) throw sessErr;
  const userId = s?.session?.user?.id;
  if (!userId) throw new Error("Not logged in");

  // pull local leads and keep only SOLD
  const localAll = loadLeads() || [];
  const localSold = localAll.filter((p) => p?.status === "sold");
  if (!localSold.length) return { scanned: localAll.length, soldFound: 0, inserted: 0, skipped: 0 };

  // fetch existing SOLD lead IDs for this user (avoid re-upserting)
  const { data: existing, error: exErr } = await supabase
    .from("leads")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "sold");
  if (exErr) throw exErr;

  const existingIds = new Set((existing || []).map((r) => r.id));

  // only migrate ones not already present
  const toInsert = localSold.filter((p) => !existingIds.has(p.id));

  if (!toInsert.length) {
    return { scanned: localAll.length, soldFound: localSold.length, inserted: 0, skipped: localSold.length };
  }

  const rows = toInsert.map((p) => ({
    id: p.id,                    // preserve local UUID
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
    sold: p.sold || null,        // {carrier, faceAmount, premium, monthlyPayment, policyNumber, effectiveDate/startDate, notes, address{street,city,state,zip}}
    updated_at: new Date().toISOString(),
  }));

  // upsert by id (safe if one somehow exists), but we're already filtering to new IDs
  const { error } = await supabase.from("leads").upsert(rows);
  if (error) throw error;

  return {
    scanned: localAll.length,
    soldFound: localSold.length,
    inserted: rows.length,
    skipped: localSold.length - rows.length,
  };
}
