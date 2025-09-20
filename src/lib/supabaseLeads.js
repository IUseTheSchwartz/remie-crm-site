// File: src/lib/supabaseLeads.js
import { supabase } from "./supabaseClient";
import { toE164 } from "./phone";

/** Return current Supabase user id (or null) */
export async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) console.error("[supabase] getUser error:", error);
  return data?.user?.id || null;
}

/** Normalize helpers */
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
const normEmail = (s) => String(s || "").trim().toLowerCase();

/** Find the server row id for this user by id, or fallback to email/phone */
async function findLeadRowIdForUser({ id, email, phone }) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const clauses = [];
  if (id) clauses.push(`id.eq.${id}`);
  if (email) clauses.push(`email.eq.${normEmail(email)}`);
  if (phone) {
    const phoneE164 = toE164(phone);
    if (phoneE164) clauses.push(`phone.eq.${phoneE164}`);
  }

  if (!clauses.length) return null;

  const { data, error } = await supabase
    .from("leads")
    .select("id, created_at")
    .eq("user_id", userId)
    .or(clauses.join(","))
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0]?.id || null;
}

/** Upsert ONE lead (used for CSV/new items) */
export async function upsertLeadServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const phoneE164 = lead.phone ? toE164(lead.phone) : null;
  if (!phoneE164 && lead.phone) {
    throw new Error(`Invalid phone number: ${lead.phone}`);
  }

  const row = {
    id: lead.id, // keep browser UUID if present
    user_id: userId,
    status: lead.status === "sold" ? "sold" : "lead",
    name: lead.name || "",
    phone: phoneE164 || "",
    email: lead.email ? normEmail(lead.email) : "",
    notes: lead.notes || "",
    dob: lead.dob || null,
    state: lead.state || "",
    beneficiary: lead.beneficiary || "",
    beneficiary_name: lead.beneficiary_name || "",
    company: lead.company || "",
    gender: lead.gender || "",
    military_branch: lead.military_branch || "",
    sold: lead.sold || null, // jsonb
    // include pipeline fields if set
    stage: lead.stage ?? null,
    stage_changed_at: lead.stage_changed_at ?? null,
    next_follow_up_at: lead.next_follow_up_at ?? null,
    last_outcome: lead.last_outcome ?? null,
    call_attempts: lead.call_attempts ?? null,
    priority: lead.priority ?? null,
    pipeline: lead.pipeline ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("leads").upsert(row);
  if (error) throw error;
  return row.id;
}

/** Upsert MANY (CSV import) */
export async function upsertManyLeadsServer(leads = []) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");
  if (!leads.length) return 0;

  const rows = leads.map((p) => {
    const phoneE164 = p.phone ? toE164(p.phone) : null;
    if (!phoneE164 && p.phone) {
      throw new Error(`Invalid phone for ${p.name || "unknown"}: ${p.phone}`);
    }

    return {
      id: p.id,
      user_id: userId,
      status: p.status === "sold" ? "sold" : "lead",
      name: p.name || "",
      phone: phoneE164 || "",
      email: p.email ? normEmail(p.email) : "",
      notes: p.notes || "",
      dob: p.dob || null,
      state: p.state || "",
      beneficiary: p.beneficiary || "",
      beneficiary_name: p.beneficiary_name || "",
      company: p.company || "",
      gender: p.gender || "",
      military_branch: p.military_branch || "",
      sold: p.sold || null,
      stage: p.stage ?? null,
      stage_changed_at: p.stage_changed_at ?? null,
      next_follow_up_at: p.next_follow_up_at ?? null,
      last_outcome: p.last_outcome ?? null,
      call_attempts: p.call_attempts ?? null,
      priority: p.priority ?? null,
      pipeline: p.pipeline ?? null,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase.from("leads").upsert(rows);
  if (error) throw error;
  return rows.length;
}

/** Update ONLY pipeline fields; first resolve the correct server row id */
export async function updatePipelineServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const targetId = await findLeadRowIdForUser({
    id: lead.id,
    email: lead.email,
    phone: lead.phone,
  });
  if (!targetId) throw new Error("No matching server lead found for user");

  const patch = {
    stage: lead.stage ?? null,
    stage_changed_at: lead.stage_changed_at ?? null,
    next_follow_up_at: lead.next_follow_up_at ?? null,
    last_outcome: lead.last_outcome ?? null,
    call_attempts: lead.call_attempts ?? null,
    priority: lead.priority ?? null,
    pipeline: lead.pipeline ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("leads")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", targetId);

  if (error) throw error;
  return targetId;
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
