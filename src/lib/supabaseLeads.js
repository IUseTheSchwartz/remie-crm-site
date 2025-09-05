// File: src/lib/supabaseLeads.js
import { supabase } from "./supabaseClient";

/** Return current Supabase user id (or null) */
export async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) console.error("[supabase] getUser error:", error);
  return data?.user?.id || null;
}

// helper: only include defined fields
const maybe = (k, v) => (v === undefined ? {} : { [k]: v });

/** Upsert ONE lead to Supabase for the current user */
export async function upsertLeadServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const row = {
    id: lead.id,                        // keep browser-generated UUID so local/server match
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
    sold: lead.sold || null,            // jsonb
    updated_at: new Date().toISOString(),
    // pipeline fields (only set if provided so we don't wipe existing)
    ...maybe("stage", lead.stage),
    ...maybe("stage_changed_at", lead.stage_changed_at),
    ...maybe("next_follow_up_at", lead.next_follow_up_at),
    ...maybe("last_outcome", lead.last_outcome),
    ...maybe("call_attempts", lead.call_attempts),
    ...maybe("priority", lead.priority),
    ...maybe("pipeline", lead.pipeline),
  };

  const { error } = await supabase.from("leads").upsert(row);
  if (error) throw error;
  return row.id;
}

/** Upsert MANY leads (CSV import) */
export async function upsertManyLeadsServer(leads = []) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");
  if (!leads.length) return 0;

  const rows = leads.map((p) => ({
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
    ...maybe("stage", p.stage),
    ...maybe("stage_changed_at", p.stage_changed_at),
    ...maybe("next_follow_up_at", p.next_follow_up_at),
    ...maybe("last_outcome", p.last_outcome),
    ...maybe("call_attempts", p.call_attempts),
    ...maybe("priority", p.priority),
    ...maybe("pipeline", p.pipeline),
  }));

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
