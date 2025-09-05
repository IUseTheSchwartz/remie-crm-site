// File: src/lib/supabaseLeads.js
import { supabase } from "./supabaseClient";

/** Return current Supabase user id (or null) */
export async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) console.error("[supabase] getUser error:", error);
  return data?.user?.id || null;
}

/** Helper: include a field only if it's present (avoid overwriting with null/empty) */
function maybe(obj, key, value) {
  return value === undefined ? obj : { ...obj, [key]: value };
}

/** Upsert ONE lead to Supabase for the current user */
export async function upsertLeadServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  let row = {
    id: lead.id,               // keep browser-generated UUID so local/server match
    user_id: userId,
    status: lead.status === "sold" ? "sold" : "lead",
    name: lead.name || "",
    phone: lead.phone || "",
    email: lead.email || "",
    notes: lead.notes || "",
    dob: lead.dob || null,
    state: lead.state || "",
    beneficiary: lead.beneficiary || "",
    beneficiary_name: lead.beneficiary_name || "",
    company: lead.company || "",
    gender: lead.gender || "",
    sold: lead.sold || null,   // jsonb
    updated_at: new Date().toISOString(),
  };

  // ✅ Include stage fields ONLY if provided, so we don't clobber existing server values.
  row = maybe(row, "stage", lead.stage);
  row = maybe(row, "stage_changed_at", lead.stage_changed_at);

  const { error } = await supabase.from("leads").upsert(row);
  if (error) throw error;
  return row.id;
}

/** Upsert MANY leads (CSV import) */
export async function upsertManyLeadsServer(leads = []) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");
  if (!leads.length) return 0;

  const rows = leads.map((p) => {
    let r = {
      id: p.id,
      user_id: userId,
      status: p.status === "sold" ? "sold" : "lead",
      name: p.name || "",
      phone: p.phone || "",
      email: p.email || "",
      notes: p.notes || "",
      dob: p.dob || null,
      state: p.state || "",
      beneficiary: p.beneficiary || "",
      beneficiary_name: p.beneficiary_name || "",
      company: p.company || "",
      gender: p.gender || "",
      sold: p.sold || null,
      updated_at: new Date().toISOString(),
    };
    // ✅ only attach if present
    r = maybe(r, "stage", p.stage);
    r = maybe(r, "stage_changed_at", p.stage_changed_at);
    return r;
  });

  const { error } = await supabase.from("leads").upsert(rows);
  if (error) throw error;
  return rows.length;
}

/** Delete ONE lead (mirror a UI delete) */
export async function deleteLeadServer(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const { error } = await supabase
    .from("leads")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw error;
  return true;
}
