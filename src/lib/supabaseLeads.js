// File: src/lib/supabaseLeads.js
import { supabase } from "./supabaseClient";
import { toE164 } from "./phone";

/** Return current Supabase user id (or null) */
export async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) console.error("[supabase] getUser error:", error);
  return data?.user?.id || null;
}

const norm = (s) => (s == null ? "" : String(s).trim());
const normEmail = (s) => norm(s).toLowerCase();

/** Build a normalized row from incoming lead-like object (keeps all new fields) */
function buildNormalizedRow(lead, userId) {
  const wantsPhone = norm(lead.phone);
  const phoneE164 = wantsPhone ? toE164(wantsPhone) : null;
  if (!phoneE164 && wantsPhone) {
    throw new Error(`Invalid phone number: ${lead.phone}`);
  }

  return {
    // NOTE: do not set id here; we'll decide target id based on lookup/merge
    user_id: userId,

    // status: never force "lead" when the incoming payload is empty — set explicitly only if caller passed it
    status: lead.status === "sold" ? "sold" : (lead.status === "lead" ? "lead" : null),

    name: norm(lead.name),
    phone: phoneE164 || null,
    email: lead.email ? normEmail(lead.email) : null,
    notes: norm(lead.notes),

    // ✅ Extra CSV fields
    dob: norm(lead.dob) || null,
    state: norm(lead.state).toUpperCase() || null,
    beneficiary: norm(lead.beneficiary),
    beneficiary_name: norm(lead.beneficiary_name),
    company: norm(lead.company),
    gender: norm(lead.gender),
    military_branch: norm(lead.military_branch),

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

    // Skip undefined
    if (nv === undefined) continue;

    // Never downgrade sold -> lead
    if (k === "status" && base.status === "sold" && nv !== "sold") continue;

    // Skip nulls (don't erase existing values during merge)
    if (nv === null) continue;

    // Skip empty strings
    if (typeof nv === "string" && nv.trim() === "") continue;

    out[k] = nv;
  }

  // always refresh updated_at
  out.updated_at = new Date().toISOString();
  return out;
}

/* ---------------- Phone/email candidate helpers ---------------- */

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function phoneVariants(raw) {
  const e164 = toE164(raw);
  const d = onlyDigits(raw);
  if (!d && !e164) return [];
  // last 10
  const ten = d?.length === 11 && d.startsWith("1") ? d.slice(1) : (d || "").slice(-10);
  const set = new Set();
  if (e164) set.add(e164);
  if (ten) {
    set.add(ten);
    set.add(`1${ten}`);
    set.add(`+1${ten}`);
  }
  return Array.from(set).filter(Boolean);
}

function uniqById(arr) {
  const m = new Map();
  for (const r of arr || []) m.set(r.id, r);
  return Array.from(m.values());
}

/** Find candidates by phone/email for this user (case-insensitive email + phone variants) */
async function findLeadCandidates({ userId, phoneE164, email }) {
  if (!userId) return [];
  const results = [];

  // Try phone matches (exact & common variants)
  const variants = phoneVariants(phoneE164);
  if (variants.length) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("user_id", userId)
      .in("phone", variants)
      .order("created_at", { ascending: false });
    if (error) throw error;
    if (data?.length) results.push(...data);
  }

  // Try case-insensitive email match
  const em = email ? normEmail(email) : null;
  if (em) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("user_id", userId)
      // ilike without % works for case-insensitive exact match
      .ilike("email", em)
      .order("created_at", { ascending: false });
    if (error) throw error;
    if (data?.length) results.push(...data);
  }

  return uniqById(results);
}

/** Smart merge write: insert | update | merge-then-delete-extras */
async function smartWriteLead(normalizedRow, { preferId } = {}) {
  const userId = normalizedRow.user_id;
  const phoneE164 = normalizedRow.phone || null;
  const email = normalizedRow.email || null;

  // 1) Find possible existing rows
  let candidates = await findLeadCandidates({ userId, phoneE164, email });

  // 2) If nothing found, try insert; on unique-email collision, re-query by email and merge
  if (candidates.length === 0) {
    try {
      const { data, error } = await supabase
        .from("leads")
        .insert([normalizedRow])
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    } catch (e) {
      // Unique email violation: fetch the conflicting row and merge instead
      const code = e?.code || e?.details?.code || e?.hint;
      const isUnique = e?.message?.includes("duplicate key value") || code === "23505";
      if (isUnique && email) {
        const { data, error } = await supabase
          .from("leads")
          .select("*")
          .eq("user_id", userId)
          .ilike("email", email)
          .order("created_at", { ascending: false });
        if (error) throw error;
        candidates = data || [];
      } else {
        throw e;
      }
    }
  }

  // 3) Choose a target row to keep
  let target = candidates[0];
  if (preferId) {
    const chosen = candidates.find((c) => c.id === preferId);
    if (chosen) target = chosen;
  }

  // 4) Merge fields into target
  const merged = mergeRows(target, normalizedRow);

  // 5) UPDATE target
  const { data: upd, error: uErr } = await supabase
    .from("leads")
    .update(merged)
    .eq("user_id", userId)
    .eq("id", target.id)
    .select("id")
    .single();
  if (uErr) throw uErr;

  // 6) If there are extras (split-brain), delete them now
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
