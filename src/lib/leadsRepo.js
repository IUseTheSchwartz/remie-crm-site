// File: src/lib/leadsRepo.js
import { supabase } from "./supabaseClient";
import { loadLeads, saveLeads, normalizePerson, upsert } from "./storage";

export async function repoLoadLeads() {
  const { data: s } = await supabase.auth.getSession();
  const userId = s?.session?.user?.id;
  if (!userId) return loadLeads();

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  if (error || !data?.length) return loadLeads();

  const mapped = data.map(r => ({
    id: r.id, name: r.name || "", phone: r.phone || "", email: r.email || "",
    status: r.status || "lead", notes: r.notes || "", dob: r.dob || "",
    state: r.state || "", beneficiary: r.beneficiary || "",
    beneficiary_name: r.beneficiary_name || "", company: r.company || "",
    gender: r.gender || "", sold: r.sold || null,
  }));
  saveLeads(mapped);
  return mapped;
}

export async function repoUpsertLead(person) {
  const norm = normalizePerson(person);
  const current = loadLeads();
  saveLeads(upsert(current, norm));

  const { data: s } = await supabase.auth.getSession();
  const userId = s?.session?.user?.id;
  if (!userId) return norm;

  const row = {
    id: norm.id, user_id: userId, name: norm.name, phone: norm.phone, email: norm.email,
    status: norm.status, notes: norm.notes, dob: norm.dob || null, state: norm.state,
    beneficiary: norm.beneficiary, beneficiary_name: norm.beneficiary_name,
    company: norm.company, gender: norm.gender, sold: norm.sold,
    updated_at: new Date().toISOString(),
  };
  await supabase.from("leads").upsert(row);
  return norm;
}

export async function repoMarkSold(leadId, soldObj) {
  const list = loadLeads();
  const idx = list.findIndex(x => x.id === leadId);
  if (idx === -1) throw new Error("Lead not found locally");
  const next = { ...list[idx], status: "sold", sold: soldObj || {} };
  saveLeads(upsert(list, next));

  const { data: s } = await supabase.auth.getSession();
  const userId = s?.session?.user?.id;
  if (!userId) return next;

  await supabase
    .from("leads")
    .update({ status: "sold", sold: next.sold, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .eq("user_id", userId);

  return next;
}
