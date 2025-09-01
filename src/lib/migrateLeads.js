// File: src/lib/migrateLeads.js
import { supabase } from "./supabaseClient";
import { loadLeads } from "./storage";

/**
 * Push localStorage leads into Supabase `leads` table for the current user.
 * Safe to run multiple times (upsert by id).
 */
export async function migrateLocalLeads() {
  const local = loadLeads() || [];

  // must be logged in so rows get your user_id
  const { data: s, error: sessErr } = await supabase.auth.getSession();
  if (sessErr) throw sessErr;
  const userId = s?.session?.user?.id;
  if (!userId) throw new Error("Not logged in");

  if (!local.length) return { inserted: 0 };

  const rows = local.map((p) => ({
    id: p.id,                    // keep same id so Lob enqueue can reference it
    user_id: userId,
    name: p.name || "",
    phone: p.phone || "",
    email: p.email || "",
    status: p.status === "sold" ? "sold" : "lead",
    notes: p.notes || "",
    dob: p.dob || null,
    state: p.state || "",
    beneficiary: p.beneficiary || "",
    beneficiary_name: p.beneficiary_name || "",
    company: p.company || "",
    gender: p.gender || "",
    sold: p.sold || null,        // { carrier, faceAmount, premium, monthlyPayment, policyNumber, effectiveDate/startDate, notes, address{street,city,state,zip} }
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("leads").upsert(rows);
  if (error) throw error;

  return { inserted: rows.length };
}
