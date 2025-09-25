// File: src/lib/supabaseLeads.js
import { supabase } from "./supabaseClient";
import { toE164 } from "./phone";

/** Return current Supabase user id (or null) */
export async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) console.error("[supabase] getUser error:", error);
  return data?.user?.id || null;
}

const normEmail = (s) => String(s || "").trim().toLowerCase();

/** Build a normalized row from incoming lead-like object */
function buildNormalizedRow(lead, userId) {
  const phoneE164 = lead.phone ? toE164(lead.phone) : null;
  if (!phoneE164 && lead.phone) {
    throw new Error(`Invalid phone number: ${lead.phone}`);
  }
  return {
    // NOTE: do not set id here; we'll decide target id based on lookup/merge
    user_id: userId,
    status: lead.status === "sold" ? "sold" : "lead",
    name: lead.name || "",
    phone: phoneE164 || null,
    email: lead.email ? normEmail(lead.email) : null,
    notes: lead.notes || "",
    dob: lead.dob || null,
    state: lead.state || "",
    beneficiary: lead.beneficiary || "",
    beneficiary_name: lead.beneficiary_name || "",
    company: lead.company || "",
    gender: lead.gender || "",
    military_branch: lead.military_branch || "",
    sold: lead.sold || null, // jsonb
    // pipeline fields
    stage: lead.stage ?? null,
    stage_changed_at: lead.stage_changed_at ?? null,
    next_follow_up_at: lead.next_follow_up_at ?? null,
    last_outcome: lead.last_outcome ?? null,
    call_attempts: lead.call_attempts ?? null,
    priority: lead.priority ?? null,
    pipeline: lead.pipeline ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** Merge helper: prefer non-empty new values, otherwise keep existing */
function mergeRows(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const nv = patch[k];
    if (nv === undefined) continue;
    if (nv === null) continue; // don't overwrite with nulls during merge
    if (typeof nv === "string" && nv.trim() === "") continue;
    out[k] = nv;
  }
  // always refresh updated_at
  out.updated_at = new Date().toISOString();
  return out;
}

/** Find candidates by phone/email for this user (handles nulls safely).
 *  Email match is case-insensitive to align with unique index on lower(email).
 */
async function findLeadCandidates({ userId, phoneE164, email }) {
  if (!phoneE164 && !email) return [];

  let query = supabase
    .from("leads")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (phoneE164 && email) {
    // phone exact OR email case-insensitive
    query = query.or(
      `phone.eq.${encodeURIComponent(phoneE164)},email.ilike.${encodeURIComponent(
        email
      )}`
    );
  } else if (phoneE164) {
    query = query.eq("phone", phoneE164);
  } else if (email) {
    query = query.ilike("email", email);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/** Smart merge write: insert | update | merge-then-delete-extras */
async function smartWriteLead(normalizedRow, { preferId } = {}) {
  const userId = normalizedRow.user_id;
  const phoneE164 = normalizedRow.phone || null;
  const email = normalizedRow.email || null;

  let candidates = await findLeadCandidates({ userId, phoneE164, email });

  if (candidates.length === 0) {
    // INSERT new; if duplicate-key occurs (due to unique (user_id, lower(email))),
    // recover by re-fetching case-insensitively and then UPDATE instead.
    try {
      const { data, error } = await supabase
        .from("leads")
        .insert([normalizedRow])
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("duplicate key value")) {
        // Re-fetch candidates now that we know a conflict exists
        candidates = await findLeadCandidates({ userId, phoneE164, email });
        if (candidates.length) {
          const target = candidates[0];
          const merged = mergeRows(target, normalizedRow);
          const { data: upd, error: uErr } = await supabase
            .from("leads")
            .update(merged)
            .eq("user_id", userId)
            .eq("id", target.id)
            .select("id")
            .single();
          if (uErr) throw uErr;
          return upd.id;
        }
      }
      throw err;
    }
  }

  // Choose a target row to keep
  let target = candidates[0];
  if (preferId) {
    const chosen = candidates.find((c) => c.id === preferId);
    if (chosen) target = chosen;
  }

  // Merge fields into target
  const merged = mergeRows(target, normalizedRow);

  // UPDATE target
  const { data: upd, error: uErr } = await supabase
    .from("leads")
    .update(merged)
    .eq("user_id", userId)
    .eq("id", target.id)
    .select("id")
    .single();
  if (uErr) throw uErr;

  // If there are extras (split-brain), delete them now
  const extras = candidates.filter((c) => c.id !== target.id);
  if (extras.length) {
    const extraIds = extras.map((x) => x.id);
    const { error: dErr } = await supabase
      .from("leads")
      .delete()
      .in("id", extraIds)
      .eq("user_id", userId);
    if (dErr) {
      // Not fatal to the caller; log and continue
      console.warn("[leads] cleanup extras failed:", dErr);
    }
  }

  return upd.id;
}

/** Public API: Upsert ONE lead with conflict-proof merging */
export async function upsertLeadServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");
  const row = buildNormalizedRow(lead, userId);

  try {
    return await smartWriteLead(row, { preferId: lead.id });
  } catch (e) {
    // As a fallback, try once more without preferId (in case preferId pointed to a deleted row)
    console.warn("[leads] smartWrite primary failed, retrying:", e?.message || e);
    return await smartWriteLead(row);
  }
}

/** Public API: Upsert MANY (CSV import) with conflict-proof merging */
export async function upsertManyLeadsServer(leads = []) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");
  if (!leads.length) return 0;

  let wrote = 0;
  for (const p of leads) {
    const row = buildNormalizedRow(p, userId);
    try {
      await smartWriteLead(row, { preferId: p.id });
      wrote++;
    } catch (e) {
      console.error("[leads] batch write failed for", p?.name || p?.email || p?.phone, e);
      // continue with next row
    }
  }
  return wrote;
}

/** Update ONLY pipeline fields; resolve correct server row id via our lookup */
export async function updatePipelineServer(lead) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not logged in to Supabase");

  const phoneE164 = lead.phone ? toE164(lead.phone) : null;
  const email = lead.email ? normEmail(lead.email) : null;
  const candidates = await findLeadCandidates({ userId, phoneE164, email });
  const target = candidates[0];
  if (!target) throw new Error("No matching server lead found for user");

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

  const { data, error } = await supabase
    .from("leads")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", target.id)
    .select("id");
  if (error) throw error;
  return data?.[0]?.id || target.id;
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
