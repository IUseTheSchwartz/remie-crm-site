// File: src/pages/LeadsPage.jsx
import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  loadLeads, saveLeads,
  loadClients, saveClients,
  normalizePerson, upsert,
} from "../lib/storage.js";

// Supabase helpers
import {
  upsertLeadServer,
  upsertManyLeadsServer,
  deleteLeadServer,
} from "../lib/supabaseLeads.js";

// Supabase browser client (read + realtime)
import { supabase } from "../lib/supabaseClient.js";

// (REPLACED) Google Sheets connector → Zapier embed
import ZapierEmbed from "../components/autoimport/ZapierEmbed.jsx";

// Phone normalizer (E.164)
import { toE164 } from "../lib/phone.js";

/* startCall so Leads page can dial exactly like Dialer */
import { startCall } from "../lib/calls";

/* (Optional) simple phone link UI; remove if you don’t want it */
const PhoneMono = ({ children }) => (
  <span className="font-mono whitespace-nowrap">{children}</span>
);

/* ---------------- Functions base (Netlify) ---------------- */
const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/* ---------------- Stage labels/styles (match PipelinePage) ------------------ */
const STAGE_STYLE = {
  no_pickup:     "bg-white/10 text-white/80",
  answered:      "bg-sky-500/15 text-sky-300",
  quoted:        "bg-amber-500/15 text-amber-300",
  app_started:   "bg-indigo-500/15 text-indigo-300",
  app_pending:   "bg-fuchsia-500/15 text-fuchsia-300",
  app_submitted: "bg-emerald-500/15 text-emerald-300",
};
function labelForStage(id) {
  const m = {
    no_pickup: "No Pickup",
    answered: "Answered",
    quoted: "Quoted",
    app_started: "App Started",
    app_pending: "App Pending",
    app_submitted: "App Submitted",
  };
  return m[id] || "No Pickup";
}

/* --------------------------- Header alias helpers --------------------------- */
const TEMPLATE_HEADERS = ["name","phone","email"]; // minimal CSV template

const H = {
  first: ["first","first name","firstname","given name","given_name","fname","first_name"],
  last:  ["last","last name","lastname","surname","family name","lname","last_name","family_name"],
  full:  ["name","full name","fullname","full_name"],
  email: ["email","e-mail","email address","mail","email_address"],
  phone: ["phone","phone number","mobile","cell","tel","telephone","number","phone_number"],
  notes: ["notes","note","comments","comment","details"],
  company:["company","business","organization","organisation"],
  // NEW fields
  dob:   ["dob","date of birth","birthdate","birth date","d.o.b.","date"],
  state: ["state","st","us state","residence state"],
  beneficiary: ["beneficiary","beneficiary type"],
  beneficiary_name: ["beneficiary name","beneficiary_name","beneficiary full name"],
  gender: ["gender","sex"],
  military_branch: ["military","military branch","branch","service branch","military_branch","branch_of_service"],
};

const norm = (s) => (s || "").toString().trim().toLowerCase();

/**
 * buildHeaderIndex(headers)
 * Matching rules prefer exact/branch-aware matches; avoids mapping "military" to "military status".
 */
function buildHeaderIndex(headers) {
  const normalized = headers.map(norm);

  const matchesCandidate = (normalizedHeader, candidate) => {
    const c = candidate.toLowerCase();
    if (normalizedHeader === c) return true;
    if (normalizedHeader === c.replace(/_/g, " ")) return true;
    if (c.includes("branch") && normalizedHeader.includes("branch")) return true;
    if (c === "military") {
      return normalizedHeader === "military" || normalizedHeader.includes("branch");
    }
    if (normalizedHeader.includes(c) && c.length > 3) return true;
    return false;
  };

  const find = (candidates) => {
    // Exact pass
    for (let i = 0; i < normalized.length; i++) {
      for (const cand of candidates) {
        if (normalized[i] === cand) return headers[i];
      }
    }
    // Prefer headers containing "branch" for military_branch
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i].includes("branch")) {
        for (const cand of candidates) {
          if (matchesCandidate(normalized[i], cand)) return headers[i];
        }
      }
    }
    // Fallback loose pass
    for (let i = 0; i < normalized.length; i++) {
      for (const cand of candidates) {
        if (matchesCandidate(normalized[i], cand)) return headers[i];
      }
    }
    return null;
  };

  return {
    first:  find(H.first),
    last:   find(H.last),
    full:   find(H.full),
    email:  find(H.email),
    phone:  find(H.phone),
    notes:  find(H.notes),
    company:find(H.company),
    dob:    find(H.dob),
    state:  find(H.state),
    beneficiary: find(H.beneficiary),
    beneficiary_name: find(H.beneficiary_name),
    gender: find(H.gender),
    military_branch: find(H.military_branch),
  };
}

function pick(row, key) {
  if (!key) return "";
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

function buildName(row, map) {
  const full = pick(row, map.full);
  if (full) return full;
  const first = pick(row, map.first);
  const last  = pick(row, map.last);
  const combined = `${first} ${last}`.trim();
  if (combined) return combined;
  const company = pick(row, map.company);
  if (company) return company;
  const email = pick(row, map.email);
  if (email && email.includes("@")) return email.split("@")[0];
  return "";
}
const buildPhone = (row, map) =>
  pick(row, map.phone) || row.phone || row.number || row.Phone || row.Number || "";
const buildEmail = (row, map) =>
  pick(row, map.email) || row.email || row.Email || "";
const buildNotes = (row, map) => pick(row, map.notes) || "";

// NEW field builders (string passthrough)
const buildDob = (row, map) => pick(row, map.dob);
const buildState = (row, map) => pick(row, map.state).toUpperCase();
const buildBeneficiary = (row, map) => pick(row, map.beneficiary);
const buildBeneficiaryName = (row, map) => pick(row, map.beneficiary_name);
const buildGender = (row, map) => pick(row, map.gender);
const buildMilitaryBranch = (row, map) => pick(row, map.military_branch);

// Dedupe helpers
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
const normEmail  = (s) => String(s || "").trim().toLowerCase();

/** Preserve local pipeline fields if they already exist for this id */
function preserveStage(existingList, incoming) {
  const found = existingList.find(x => x.id === incoming.id);
  if (!found) return incoming;
  const keep = { ...incoming };
  const F = ["stage","stage_changed_at","next_follow_up_at","last_outcome","call_attempts","priority","pipeline"];
  for (const k of F) {
    if (found[k] !== undefined && found[k] !== null) keep[k] = found[k];
  }
  return keep;
}

/* -------------------- Contacts sync helpers (Lead & Sold) -------------------- */
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);
const normalizePhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; // drop leading US '1'
};

/** Find a contact by user+phone using normalized digits */
async function findContactByUserAndPhone(userId, rawPhone) {
  const phoneNorm = normalizePhone(rawPhone);
  if (!phoneNorm) return null;
  const { data, error } = await supabase
    .from("message_contacts")
    .select("id, phone, full_name, tags")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).find((c) => normalizePhone(c.phone) === phoneNorm) || null;
}

/** Ensure EXCLUSIVE status: 'military' OR 'lead' (not both). Always store E.164 phone. */
async function upsertLeadContact({ userId, phone, fullName, militaryBranch }) {
  if (!phone) return;
  const phoneE164 = toE164(phone);
  if (!phoneE164) throw new Error(`Invalid phone: ${phone}`);

  const existing = await findContactByUserAndPhone(userId, phone);
  const wantsMilitary = Boolean((militaryBranch || "").trim());

  // Remove old status tags, then add exactly one
  const baseTags = (existing?.tags || []).filter(
    (t) => !["lead", "military"].includes(normalizeTag(t))
  );
  const statusTag = wantsMilitary ? "military" : "lead";
  const nextTags = uniqTags([...baseTags, statusTag]);

  if (existing) {
    const { error } = await supabase
      .from("message_contacts")
      .update({ phone: phoneE164, full_name: fullName || existing.full_name || null, tags: nextTags })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  } else {
    const { data, error } = await supabase
      .from("message_contacts")
      .insert([{ user_id: userId, phone: phoneE164, full_name: fullName || null, tags: nextTags }])
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
}

/** Build final tags for SOLD: replace status → 'sold', optionally add birthday/holiday/payment_reminder */
function buildSoldTags(currentTags, { addBdayHoliday, addPaymentReminder }) {
  const base = (currentTags || []).filter(
    (t) => !["lead", "military", "sold"].includes(normalizeTag(t))
  );
  const out = [...base, "sold"];
  if (addBdayHoliday) out.push("birthday_text", "holiday_text");
  if (addPaymentReminder) out.push("payment_reminder");
  return uniqTags(out);
}

/** Update existing contact or insert a new one with SOLD tags. Store E.164 phone. */
async function upsertSoldContact({ userId, phone, fullName, addBdayHoliday, addPaymentReminder }) {
  if (!phone) return;
  const phoneE164 = toE164(phone);
  if (!phoneE164) throw new Error(`Invalid phone: ${phone}`);

  const existing = await findContactByUserAndPhone(userId, phone);

  if (existing) {
    const nextTags = buildSoldTags(existing.tags, { addBdayHoliday, addPaymentReminder });
    const { error } = await supabase
      .from("message_contacts")
      .update({ phone: phoneE164, full_name: fullName || existing.full_name || null, tags: nextTags })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  } else {
    const nextTags = buildSoldTags([], { addBdayHoliday, addPaymentReminder });
    const { data, error } = await supabase
      .from("message_contacts")
      .insert([{ user_id: userId, phone: phoneE164, full_name: fullName || null, tags: nextTags }])
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
}

/* --------- NEW: Contact delete helpers so Leads delete cleans up Contacts --------- */
function buildPhoneVariants(rawPhone) {
  const s = String(rawPhone || "").trim();
  if (!s) return [];
  const d = s.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.slice(-10);
  const variants = new Set([s, ten, `1${ten}`, `+1${ten}`]);
  return Array.from(variants).filter(Boolean);
}

async function deleteContactsByPhones(userId, phones) {
  if (!userId) return;
  const allVariants = new Set();
  for (const p of phones || []) {
    for (const v of buildPhoneVariants(p)) allVariants.add(v);
  }
  const list = Array.from(allVariants);
  if (list.length === 0) return;

  const { error } = await supabase
    .from("message_contacts")
    .delete()
    .eq("user_id", userId)
    .in("phone", list);

  if (error) throw error;
}
/* ------------------------------------------------------------------------------ */

/* -------------------- Auto-text helpers (server + fallback) -------------------- */

// Recently inserted lead id for this user (match by normalized email/phone within 10m)
async function findRecentlyInsertedLeadId({ userId, person }) {
  if (!person) return null;

  // Resolve userId if not provided
  try {
    if (!userId) {
      const u = await supabase.auth.getUser();
      userId = u?.data?.user?.id || null;
    }
  } catch {}
  if (!userId) {
    console.warn("[auto-text] no userId; cannot lookup lead");
    return null;
  }

  const orParts = [];
  const Sx = (x) => (x == null ? "" : String(x).trim());
  const email = Sx(person.email).toLowerCase();
  const phoneE164 = toE164(Sx(person.phone));
  if (email) orParts.push(`email.eq.${encodeURIComponent(email)}`);
  if (phoneE164) orParts.push(`phone.eq.${encodeURIComponent(phoneE164)}`);
  if (orParts.length === 0) return null;

  const cutoffISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("leads")
    .select("id, created_at")
    .eq("user_id", userId)
    .gte("created_at", cutoffISO)
    .or(orParts.join(","))
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;
  return data[0].id;
}

// Try multiple template keys for SOLD (includes your "sold" key)
async function sendSoldAutoText({ leadId, person }) {
  try {
    const [{ data: authUser }, { data: sess }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ]);
    const userId = authUser?.user?.id;
    const token = sess?.session?.access_token;
    if (!userId || !leadId) {
      console.warn("[sold-auto] missing ids", { userId, leadId });
      return;
    }

    // Try a few common keys so you don't have to rename in DB
    const tryKeys = ["sold", "sold_welcome", "policy_info", "sold_policy", "policy"];

    for (const templateKey of tryKeys) {
      console.log("[sold-auto] trying template", templateKey);
      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          requesterId: userId,
          lead_id: leadId,
          templateKey,
        }),
      });
      const out = await res.json().catch(() => ({}));
      console.log("[sold-auto] result", templateKey, res.status, out);

      // success or deduped → stop
      if (res.ok && (out?.ok || out?.deduped)) return;

      // if disabled or not found, try next key
      if (out?.status === "skipped_disabled" || out?.error === "template_not_found") continue;

      // any other error → stop trying to avoid noise
      break;
    }
  } catch (e) {
    console.warn("[sold-auto] error", e?.message || e);
  }
}

/* --------- ROBUST military-first new lead auto-text (server + fallback) --------- */
async function triggerAutoTextForLeadId({ leadId, userId, person }) {
  // Resolve IDs
  try {
    if (!userId) {
      const u = await supabase.auth.getUser();
      userId = u?.data?.user?.id || null;
    }
  } catch {}
  if (!leadId) {
    leadId = await findRecentlyInsertedLeadId({ userId, person });
  }
  if (!leadId || !userId) {
    console.warn("[auto-text] skipped; missing ids", { leadId, userId });
    return;
  }

  const Sx = (x) => (x == null ? "" : String(x).trim());
  const to = toE164(Sx(person?.phone));
  if (!to) { console.warn("[auto-text] invalid phone; cannot send"); return; }

  // Decide military vs normal
  let isMilitary = !!Sx(person?.military_branch);
  if (!isMilitary) {
    try {
      const { data: contact } = await supabase
        .from("message_contacts")
        .select("tags")
        .eq("user_id", userId)
        .eq("phone", to)
        .maybeSingle();
      const tags = (contact?.tags || []).map(t => String(t).trim().toLowerCase());
      if (tags.includes("military")) isMilitary = true;
    } catch {}
  }

  const militaryKeys = ["new_lead_military","military","lead_military","new_military"];
  const normalKeys   = ["new_lead","lead","new_lead_default"];

  // Helper to call server messages-send with a templateKey (even if we don't have a body)
  async function tryServerSend(templateKey) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ requesterId: userId, lead_id: leadId, templateKey }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && (out?.ok || out?.sent || out?.deduped)) {
        console.log("[auto-text] server sent using", templateKey, out);
        return true;
      }
      console.warn("[auto-text] server-send did not send", templateKey, res.status, out);
      return false;
    } catch (e) {
      console.warn("[auto-text] server-send error", e?.message || e);
      return false;
    }
  }

  // Helper to read templates row and find a body under many possible places
  async function fetchBodyFromKeys(keys) {
    const { data: mt } = await supabase
      .from("message_templates")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!mt) return null;

    const enabledFor = (key) => {
      if (typeof mt.enabled === "boolean") return mt.enabled;
      if (mt.enabled && typeof mt.enabled === "object" && key in mt.enabled) {
        return !!mt.enabled[key];
      }
      // default allow
      return true;
    };

    for (const key of keys) {
      if (!enabledFor(key)) continue;
      const fromJson = mt.templates?.[key];
      const fromTop  = mt[key];
      const body = Sx(fromJson || fromTop);
      if (body) return { key, body };
    }
    return null;
  }

  // 1) If military, aggressively try military flows first
  if (isMilitary) {
    for (const k of militaryKeys) {
      if (await tryServerSend(k)) return;
    }
    const mb = await fetchBodyFromKeys(militaryKeys);
    if (mb?.body) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch(`${FN_BASE}/messages-send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            requesterId: userId,
            lead_id: leadId,
            to,
            body: mb.body,
            templateKey: mb.key,
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && (out?.ok || out?.sent || out?.deduped)) {
          console.log("[auto-text] client sent military via body", mb.key);
          return;
        }
        console.warn("[auto-text] client body send failed", res.status, out);
      } catch (e) {
        console.warn("[auto-text] client body send error", e?.message || e);
      }
    }
    for (const k of normalKeys) {
      if (await tryServerSend(k)) return;
    }
    const nb = await fetchBodyFromKeys(normalKeys);
    if (nb?.body) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch(`${FN_BASE}/messages-send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            requesterId: userId,
            lead_id: leadId,
            to,
            body: nb.body,
            templateKey: nb.key,
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && (out?.ok || out?.sent || out?.deduped)) {
          console.log("[auto-text] client sent normal fallback body", nb.key);
          return;
        }
      } catch (e) {
        console.warn("[auto-text] client normal fallback error", e?.message || e);
      }
    }
    console.warn("[auto-text] no template sent (military flow exhausted)");
    return;
  }

  // 2) Non-military: normal flow
  for (const k of normalKeys) {
    if (await tryServerSend(k)) return;
  }
  const nb = await fetchBodyFromKeys(normalKeys);
  if (nb?.body) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          requesterId: userId,
          lead_id: leadId,
          to,
          body: nb.body,
          templateKey: nb.key,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && (out?.ok || out?.sent || out?.deduped)) {
        console.log("[auto-text] client sent normal body", nb.key);
        return;
      }
    } catch (e) {
      console.warn("[auto-text] client normal send error", e?.message || e);
    }
  }
  console.warn("[auto-text] no template sent (normal flow exhausted)");
}

/* ------------------------------------------------------------------------------ */

export default function LeadsPage() {
  const [tab, setTab] = useState("clients"); // 'clients' | 'sold'
  const [leads, setLeads] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);         // Mark-as-SOLD drawer
  const [viewSelected, setViewSelected] = useState(null); // read-only policy drawer
  const [filter, setFilter] = useState("");

  /* NEW: caller (agent) phone for dialing from this page */
  const [agentPhone, setAgentPhone] = useState("");

  const [serverMsg, setServerMsg] = useState("");
  const [showConnector, setShowConnector] = useState(false);
  const [showAdd, setShowAdd] = useState(false); // manual add modal

  // selection for mass actions
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    setLeads(loadLeads());
    setClients(loadClients());
  }, []);

  /* Load saved agent phone (same as Dialer) */
  useEffect(() => {
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        const { data, error } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", userId)
          .maybeSingle();

        if (!error && data?.phone) setAgentPhone(data.phone);
      } catch (e) {
        console.error("load agent phone failed:", e);
      }
    })();
  }, []);

  // Helper to save agent phone if user enters it here
  async function saveAgentPhone(newPhone) {
    const phone = (newPhone || "").trim();
    if (!phone) return;
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      const { data: existing } = await supabase
        .from("agent_profiles")
        .select("user_id")
        .eq("user_id", uid)
        .maybeSingle();

      if (existing) {
        await supabase.from("agent_profiles").update({ phone }).eq("user_id", uid);
      } else {
        await supabase.from("agent_profiles").insert({ user_id: uid, phone });
      }
      setAgentPhone(phone);
    } catch (e) {
      console.error("saveAgentPhone failed", e);
      alert("Could not save your phone. Try again on the Dialer page.");
    }
  }

  // Click-to-call from Leads page with graceful prompt if agent phone is missing
  async function onCallLead(leadNumber, contactId) {
    try {
      const to = toE164(leadNumber);
      if (!to) return alert("Invalid lead phone.");

      let fromAgent = agentPhone;
      if (!fromAgent) {
        const p = prompt("Enter your phone (we call you first):", "+1 ");
        if (!p) return; // user cancelled
        const e164 = toE164(p);
        if (!e164) return alert("That phone doesn’t look valid. Use +1XXXXXXXXXX");
        await saveAgentPhone(e164);
        fromAgent = e164;
      }

      await startCall({ agentNumber: fromAgent, leadNumber: to, contactId });
      setServerMsg("📞 Calling…");
    } catch (e) {
      alert(e.message || "Failed to start call");
    }
  }

  // One-time server pull → merge without duplicates (id/email/phone)
  useEffect(() => {
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        const { data: rows, error } = await supabase
          .from("leads")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error || !rows?.length) return;

        const byId = new Set([...clients, ...leads].map(r => r.id));
        const emails = new Set([...clients, ...leads].map(r => normEmail(r.email)).filter(Boolean));
        const phones = new Set([...clients, ...leads].map(r => onlyDigits(r.phone)).filter(Boolean));

        const existingAll = [...clients, ...leads];

        const incoming = rows
          .filter(r => {
            const idDup = byId.has(r.id);
            const eDup = r.email && emails.has(normEmail(r.email));
            const pDup = r.phone && phones.has(onlyDigits(r.phone));
            return !(idDup || eDup || pDup);
          })
          .map(r => preserveStage(existingAll, r));

        if (incoming.length) {
          const newLeads = [...incoming, ...leads];
          const newClients = [...incoming, ...clients];
          saveLeads(newLeads);
          saveClients(newClients);
          setLeads(newLeads);
          setClients(newClients);
        }
      } catch (e) {
        console.error("Initial server pull failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime inserts → ignore duplicates (id/email/phone)
  // IMPORTANT: We NO LONGER auto-send texts here (server handles it on ingest).
  useEffect(() => {
    let channel;
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        channel = supabase
          .channel("leads_inserts")
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "leads", filter: `user_id=eq.${userId}` },
            (payload) => {
              const row = preserveStage([...leads, ...clients], payload.new);

              const idDup = [...leads, ...clients].some(x => x.id === row.id);
              const eDup = row.email && [...leads, ...clients].some(x => normEmail(x.email) === normEmail(row.email));
              const pDup = row.phone && [...leads, ...clients].some(x => onlyDigits(x.phone) === onlyDigits(row.phone));
              if (idDup || eDup || pDup) return;

              const newLeads = [row, ...leads];
              const newClients = [row, ...clients];
              saveLeads(newLeads);
              saveClients(newClients);
              setLeads(newLeads);
              setClients(newClients);
              setServerMsg("✅ New lead arrived");

              // ❌ Removed: do NOT upsert contact or send auto-text here.
              // The server-side inbound (Zapier) already upserts contact and sends the text.
            }
          )
          .subscribe();
      } catch (e) {
        console.error("Realtime subscribe failed:", e);
      }
    })();

    return () => { if (channel) supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, clients]);

  // Merge clients + leads into a deduped "Leads" view
  const allClients = useMemo(() => {
    const map = new Map();
    for (const x of clients) map.set(x.id, x);
    for (const y of leads) if (!map.has(y.id)) map.set(y.id, y);
    return [...map.values()];
  }, [clients, leads]);

  const onlySold  = useMemo(() => allClients.filter(c => c.status === "sold"), [allClients]);

  const visible = useMemo(() => {
    const src = tab === "clients" ? allClients : onlySold;
    const q = filter.trim().toLowerCase();
    return q
      ? src.filter(r =>
          [r.name, r.email, r.phone, r.state, r.gender, r.beneficiary_name, r.military_branch, labelForStage(r.stage)]
            .some(v => (v||"").toString().toLowerCase().includes(q)))
      : src;
  }, [tab, allClients, onlySold, filter]);

  // CSV import with duplicate skipping (email OR phone)
  async function handleImportCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: async (res) => {
        const rows = res.data || [];
        if (!rows.length) {
          alert("CSV has no rows.");
          return;
        }
        const headers = Object.keys(rows[0] || {});
        const map = buildHeaderIndex(headers);

        // Existing identifiers
        const existingEmails = new Set(
          [...clients, ...leads].map((r) => normEmail(r.email)).filter(Boolean)
        );
        const existingPhones = new Set(
          [...clients, ...leads].map((r) => onlyDigits(r.phone)).filter(Boolean)
        );

        // Track duplicates within the same CSV
        const seenEmails = new Set();
        const seenPhones = new Set();

        // Normalize and filter
        const uniqueToAdd = [];
        for (const r of rows) {
          const name  = r.name || r.Name || buildName(r, map);
          const phone = buildPhone(r, map);
          const email = buildEmail(r, map);
          const notes = buildNotes(r, map);

          // NEW fields
          const dob  = buildDob(r, map);
          const state = buildState(r, map);
          const beneficiary = buildBeneficiary(r, map);
          const beneficiary_name = buildBeneficiaryName(r, map);
          const gender = buildGender(r, map);
          const military_branch = buildMilitaryBranch(r, map);

          const person = normalizePerson({
            name, phone, email, notes,
            stage: "no_pickup",
            dob, state, beneficiary, beneficiary_name, gender, military_branch,
          });

          if (!(person.name || person.phone || person.email)) continue;

          const e = normEmail(person.email);
          const p = onlyDigits(person.phone);

          const emailDup = e && (existingEmails.has(e) || seenEmails.has(e));
          const phoneDup = p && (existingPhones.has(p) || seenPhones.has(p));
          if (emailDup || phoneDup) continue;

          if (e) seenEmails.add(e);
          if (p) seenPhones.add(p);

          uniqueToAdd.push(person);
        }

        if (!uniqueToAdd.length) {
          setServerMsg("No new leads found in CSV (duplicates skipped).");
          return;
        }

        // Optimistic local update first
        const newLeads = [...uniqueToAdd, ...leads];
        const newClients = [...uniqueToAdd, ...clients];
        saveLeads(newLeads);
        saveClients(newClients);
        setLeads(newLeads);
        setClients(newClients);
        setTab("clients");

        // Try server batch upsert
        try {
          setServerMsg(`Syncing ${uniqueToAdd.length} new lead(s) to Supabase…`);
          const count = await upsertManyLeadsServer(uniqueToAdd);
          setServerMsg(`✅ CSV synced (${count} new) — duplicates skipped`);
        } catch (e) {
          console.error("CSV sync error:", e);
          setServerMsg(`⚠️ CSV sync failed: ${e.message || e}`);
        }

        // NOTE: CSV path intentionally does NOT create Contacts or send messages.
      },
      error: (err) => alert("CSV parse error: " + err.message),
    });
  }

  function downloadTemplate() {
    const csv = Papa.unparse([Object.fromEntries(TEMPLATE_HEADERS.map(h => [h, ""]))], { header: true });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "remie_leads_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openAsSold(person) { setSelected(person); }

  /** Case-insensitive email lookup: find an existing lead id for this user */
  async function findLeadIdByUserAndEmailCI(userId, email) {
    const e = (email || "").trim();
    if (!userId || !e) return null;
    try {
      const { data, error } = await supabase
        .from("leads")
        .select("id")
        .eq("user_id", userId)
        .ilike("email", e)
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return data.id || null;
    } catch {
      return null;
    }
  }

  async function saveSoldInfo(id, soldPayload) {
    let list = [...allClients];
    const idx = list.findIndex(x => x.id === id);
    const base = idx >= 0 ? list[idx] : normalizePerson({ id });

    // normalize email to lowercase so it aligns with DB unique (user_id, lower(email))
    const emailLower = (soldPayload.email || base.email || "").trim().toLowerCase();

    const updated = {
      ...base,
      status: "sold",
      sold: {
        carrier: soldPayload.carrier || "",
        faceAmount: soldPayload.faceAmount || "",
        premium: soldPayload.premium || "",           // AP stored here
        monthlyPayment: soldPayload.monthlyPayment || "",
        policyNumber: soldPayload.policyNumber || "",
        startDate: soldPayload.startDate || "",
        name: soldPayload.name || base.name || "",
        phone: soldPayload.phone || base.phone || "",
        email: emailLower,
      },
      name: soldPayload.name || base.name || "",
      phone: soldPayload.phone || base.phone || "",
      email: emailLower,

      // Keep only bday/holiday toggle
      automationPrefs: {
        bdayHolidayTexts: !!soldPayload.enableBdayHolidayTexts,
      },
    };

    // Optimistic local write
    const nextClients = upsert(clients, updated);
    const nextLeads   = upsert(leads, updated);
    saveClients(nextClients);
    saveLeads(nextLeads);
    setClients(nextClients);
    setLeads(nextLeads);

    setSelected(null);
    setTab("sold");

    // --- Save to Supabase and capture id (reusing existing row if same email)
    let savedId = null;
    try {
      setServerMsg("Syncing SOLD to Supabase…");

      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id || null;

      if (userId && updated.email) {
        const existingId = await findLeadIdByUserAndEmailCI(userId, updated.email);
        if (existingId && existingId !== updated.id) {
          updated.id = existingId; // ensure server takes UPDATE path
        }
      }

      savedId = await upsertLeadServer(updated);
      setServerMsg("✅ SOLD synced");
    } catch (e) {
      console.error("SOLD sync error:", e);
      setServerMsg(`⚠️ SOLD sync failed: ${e.message || e}`);
    }

    // --- Reflect to contacts (tags) ---
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (userId) {
        await upsertSoldContact({
          userId,
          phone: updated.phone,
          fullName: updated.name,
          addBdayHoliday: !!soldPayload.enableBdayHolidayTexts,
          addPaymentReminder: Boolean((soldPayload.startDate || "").trim()),
        });
      }
    } catch (err) {
      console.error("Contact tag sync (sold) failed:", err);
    }

    // --- Auto-send SOLD text (tries multiple template keys incl. "sold") ---
    try {
      if (savedId) {
        console.log("[sold-auto] initiating send for lead", savedId);
        await sendSoldAutoText({ leadId: savedId, person: updated });
        setServerMsg("📨 Sold policy text queued");
      } else {
        console.warn("[sold-auto] no saved lead id; skipping");
      }
    } catch (e) {
      console.error("Sold policy send error:", e);
      setServerMsg(`⚠️ Sold text error: ${e.message || e}`);
    }
  }

  /* -------------------- DELETE single (lead + contact) -------------------- */
  async function removeOne(id) {
    if (!confirm("Delete this record? This affects both local and Supabase, and will also remove the matching Contact.")) return;

    // Find the record locally to get its phone before we drop it
    const rec = [...clients, ...leads].find(r => r.id === id);
    const phone = rec?.phone;

    // Optimistic local removal
    const nextClients = clients.filter(c => c.id !== id);
    const nextLeads   = leads.filter(l => l.id !== id);
    saveClients(nextClients);
    saveLeads(nextLeads);
    setClients(nextClients);
    setLeads(nextLeads);
    if (selected?.id === id) setSelected(null);

    // remove from selectedIds if present
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });

    try {
      setServerMsg("Deleting on Supabase…");
      await deleteLeadServer(id);
      setServerMsg("🗑️ Deleted lead in Supabase");
    } catch (e) {
      console.error("Delete server error:", e);
      setServerMsg(`⚠️ Could not delete lead on Supabase: ${e.message || e}`);
    }

    // Delete matching contact by phone variants
    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (userId && phone) {
        await deleteContactsByPhones(userId, [phone]);
        setServerMsg("🧹 Deleted matching contact");
      }
    } catch (e) {
      console.error("Contact delete error:", e);
      setServerMsg(`⚠️ Contact delete failed: ${e.message || e}`);
    }
  }

  function removeAll() {
    if (!confirm("Clear ALL locally stored leads/clients? (This does NOT delete from Supabase)")) return;
    saveLeads([]);
    saveClients([]);
    setLeads([]);
    setClients([]);
    setSelected(null);
    setSelectedIds(new Set()); // clear selection
  }

  // selection helpers & bulk delete
  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const visibleIds = visible.map(v => v.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => next.has(id));
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
        return next;
      } else {
        for (const id of visibleIds) next.add(id);
        return next;
      }
    });
  }

  /* -------------------- DELETE bulk (leads + contacts) -------------------- */
  async function removeSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected record(s)? This affects both local and Supabase, and will also remove matching Contacts.`)) return;

    const idsToDelete = Array.from(selectedIds);

    // Collect phones before we drop from local so we can delete contacts
    const phonesToDelete = [...clients, ...leads]
      .filter(r => idsToDelete.includes(r.id))
      .map(r => r.phone)
      .filter(Boolean);

    // Optimistic local removal
    const nextClients = clients.filter(c => !idsToDelete.includes(c.id));
    const nextLeads   = leads.filter(l  => !idsToDelete.includes(l.id));
    saveClients(nextClients);
    saveLeads(nextLeads);
    setClients(nextClients);
    setLeads(nextLeads);
    setSelectedIds(new Set()); // clear selection
    setSelected(null);

    // Server deletes
    setServerMsg(`Deleting ${idsToDelete.length} selected...`);
    let failed = [];
    for (const id of idsToDelete) {
      try {
        await deleteLeadServer(id);
      } catch (e) {
        console.error("Bulk delete failed for", id, e);
        failed.push({ id, error: e });
      }
    }

    // Delete matching contacts in one go
    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (userId && phonesToDelete.length) {
        await deleteContactsByPhones(userId, phonesToDelete);
      }
    } catch (e) {
      console.error("Bulk contact delete failed:", e);
      // keep going; lead deletes already applied
    }

    if (failed.length === 0) {
      setServerMsg(`🗑️ Deleted ${idsToDelete.length} selected (and matching contacts)`);
    } else {
      setServerMsg(`⚠️ ${failed.length} deletion(s) failed. See console for details.`);
    }
  }

  // Manual add: uses saved id to trigger auto-text (no lookup race)
  async function handleManualAdd(personInput) {
    const person = normalizePerson({
      ...personInput,
      stage: "no_pickup",
    });

    if (!(person.name || person.phone || person.email)) {
      alert("Enter at least a name, phone, or email.");
      return;
    }

    // Optimistic local (avoid duplicating locally if same phone/email already present)
    const emailKey = normEmail(person.email);
    const phoneKey = onlyDigits(person.phone);
    const isDupLocal = [...clients, ...leads].some((r) => {
      const e = normEmail(r.email);
      const p = onlyDigits(r.phone);
      return (emailKey && e && e === emailKey) || (phoneKey && p && p === phoneKey);
    });

    if (!isDupLocal) {
      const newLeads = [person, ...leads];
      const newClients = [person, ...clients];
      saveLeads(newLeads);
      saveClients(newClients);
      setLeads(newLeads);
      setClients(newClients);
    }
    setTab("clients");
    setShowAdd(false);

    // Server upsert → capture id
    let savedId = null;
    try {
      setServerMsg("Saving lead to Supabase…");
      savedId = await upsertLeadServer(person);
      setServerMsg(isDupLocal ? "ℹ️ Lead already existed — merged on server" : "✅ Lead saved");
    } catch (e) {
      console.error("Manual add sync error:", e);
      setServerMsg(`⚠️ Save failed: ${e.message || e}`);
    }

    // Reflect to contacts + trigger auto-text using savedId
    // (We keep this for manual adds since Zapier isn’t involved here.)
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (userId) {
        await upsertLeadContact({
          userId,
          phone: person.phone,
          fullName: person.name,
          militaryBranch: person.military_branch,
        });

        await triggerAutoTextForLeadId({ leadId: savedId, userId, person });
      }
    } catch (err) {
      console.error("Contact tag sync / auto-text (manual add) failed:", err);
    }
  }

  // Sold tab uses SAME columns as Leads (no policy columns visible)
  const baseHeaders = ["Name","Phone","Email","DOB","State","Beneficiary","Beneficiary Name","Gender","Military Branch","Stage"];
  const colCount = baseHeaders.length + 2; // + Select checkbox + Actions

  return (
    <div className="space-y-6 min-w-0 overflow-x-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-white/15 bg-white/5 p-1 text-sm">
          {[
            { id:"clients", label:"Leads" },
            { id:"sold",    label:"Sold"  },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3 py-1 ${tab===t.id ? "bg-white text-black" : "text-white/80"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowConnector(s => !s)}
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
          aria-expanded={showConnector}
          aria-controls="auto-import-panel"
          title="Connect Google Sheets via Zapier"
        >
          {showConnector ? "Close setup" : "Setup auto import (Zapier)"}
        </button>

        {/* Manual add lead */}
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm"
          title="Manually add a single lead"
        >
          Add lead
        </button>

        <label className="ml-auto inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm cursor-pointer">
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleImportCsv(e.target.files[0])}
          />
          Import CSV
        </label>

        <button
          onClick={downloadTemplate}
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
        >
          Download CSV template
        </button>

        <button
          onClick={removeAll}
          className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm"
        >
          Clear all (local)
        </button>

        {/* Bulk delete button */}
        <button
          onClick={removeSelected}
          disabled={selectedIds.size === 0}
          className={`rounded-xl border ${selectedIds.size ? "border-rose-500/60 bg-rose-500/10" : "border-white/10 bg-white/5"} px-3 py-2 text-sm`}
          title="Delete selected leads (local + Supabase + Contacts)"
        >
          Delete selected ({selectedIds.size})
        </button>
      </div>

      {/* Server status line (non-blocking) */}
      {serverMsg && (
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/80">
          {serverMsg}
        </div>
      )}

      {/* Collapsible connector panel */}
      {showConnector && (
        <div
          id="auto-import-panel"
          className="my-4 rounded-2xl border border-white/15 bg-white/[0.03] p-4"
        >
          {/* New Zapier embed replaces GoogleSheetsConnector */}
          <ZapierEmbed />
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
          placeholder="Search by name, phone, email, state…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-[1200px] w-full border-collapse text-sm">
          <thead className="bg-white/[0.04] text-white/70">
            <tr>
              <Th>
                <input
                  type="checkbox"
                  onChange={toggleSelectAll}
                  checked={visible.length > 0 && visible.every(v => selectedIds.has(v.id))}
                  aria-label="Select all visible"
                />
              </Th>
              {baseHeaders.map(h => <Th key={h}>{h}</Th>)}
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const isSold = p.status === "sold";
              const stageId = p.stage || "no_pickup";
              const stageLabel = labelForStage(stageId);
              const stageClass = STAGE_STYLE[stageId] || "bg-white/10 text-white/80";
              return (
                <tr key={p.id} className="border-t border-white/10">
                  <Td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      aria-label={`Select ${p.name || p.id}`}
                    />
                  </Td>
                  <Td>{p.name || "—"}</Td>

                  {/* Phone: show number + our call button (no dependency on other components) */}
                  <Td>
                    {p.phone ? (
                      <div className="flex items-center gap-2">
                        <PhoneMono>{p.phone}</PhoneMono>
                        <button
                          onClick={() => onCallLead(p.phone, p.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 hover:bg-emerald-500/15"
                          title="Call this lead"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.11.37 2.31.57 3.58.57a1 1 0 011 1V21a1 1 0 01-1 1C10.07 22 2 13.93 2 3a1 1 0 011-1h3.5a1 1 0 011 1c0 1.27.2 2.47.57 3.58a1 1 0 01-.24 1.01l-2.21 2.2z"/></svg>
                          <span>Call</span>
                        </button>
                      </div>
                    ) : "—"}
                  </Td>

                  <Td>{p.email || "—"}</Td>
                  <Td>{p.dob || "—"}</Td>
                  <Td>{p.state || "—"}</Td>
                  <Td>{p.beneficiary || "—"}</Td>
                  <Td>{p.beneficiary_name || "—"}</Td>
                  <Td>{p.gender || "—"}</Td>
                  <Td>{p.military_branch || "—"}</Td>
                  <Td>
                    {isSold ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                        Sold
                      </span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-xs ${stageClass}`}>
                        {stageLabel}
                      </span>
                    )}
                  </Td>

                  <Td>
                    <div className="flex items-center gap-2">
                      {tab === "clients" ? (
                        <button
                          onClick={() => openAsSold(p)}
                          className="rounded-lg border border-white/15 px-2 py-1 hover:bg-white/10"
                        >
                          Mark as SOLD
                        </button>
                      ) : (
                        <button
                          onClick={() => setViewSelected(p)}
                          className="rounded-lg border border-white/15 px-2 py-1 hover:bg-white/10"
                          title="View policy file"
                        >
                          Open file
                        </button>
                      )}
                      <button
                        onClick={() => removeOne(p.id)}
                        className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 hover:bg-rose-500/20"
                        title="Delete (local + Supabase + Contact)"
                      >
                        Delete
                      </button>
                    </div>
                  </Td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={colCount} className="p-6 text-center text-white/60">
                  No records yet. Import a CSV or add leads.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer for SOLD (create/edit sold) */}
      {selected && (
        <SoldDrawer
          initial={selected}
          allClients={allClients}
          onClose={() => setSelected(null)}
          onSave={(payload) => saveSoldInfo(payload.id, payload)}
        />
      )}

      {/* Read-only policy viewer for SOLD rows */}
      {viewSelected && (
        <PolicyViewer
          person={viewSelected}
          onClose={() => setViewSelected(null)}
        />
      )}

      {/* Manual Add Lead modal */}
      {showAdd && (
        <ManualAddLeadModal
          onClose={() => setShowAdd(false)}
          onSave={handleManualAdd}
        />
      )}
    </div>
  );
}

function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-2">{children}</td>; }

/* ------------------------------ Policy Viewer ------------------------------ */
function PolicyViewer({ person, onClose }) {
  const s = person?.sold || {};
  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-4">
      <div className="relative m-auto w-full max-w-3xl rounded-2xl border border-white/15 bg-neutral-950 p-5">
        <div className="mb-3 text-lg font-semibold">Policy File</div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><div className="ro">{s.name || person?.name || "—"}</div></Field>
          <Field label="Phone"><div className="ro">{s.phone || person?.phone || "—"}</div></Field>
          <Field label="Email"><div className="ro break-all">{s.email || person?.email || "—"}</div></Field>

          <Field label="Carrier"><div className="ro">{s.carrier || "—"}</div></Field>
          <Field label="Face Amount"><div className="ro">{s.faceAmount || "—"}</div></Field>
          <Field label="AP (Annual premium)"><div className="ro">{s.premium || "—"}</div></Field>
          <Field label="Monthly Payment"><div className="ro">{s.monthlyPayment || "—"}</div></Field>
          <Field label="Policy #"><div className="ro">{s.policyNumber || "—"}</div></Field>
          <Field label="Start Date"><div className="ro">{s.startDate || "—"}</div></Field>
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button
            onClick={onClose}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10">
            Close
          </button>
        </div>
      </div>

      <style>{`.ro{padding:.5rem .75rem; border-radius:.75rem; border:1px solid rgba(255,255,255,.08); background:#00000040}`}</style>
    </div>
  );
}

/* ------------------------------ Sold Drawer ------------------------------- */
function SoldDrawer({ initial, allClients, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial?.id || (self && self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : Math.random().toString(36).slice(2)),
    name: initial?.name || "",
    phone: initial?.phone || "",
    email: initial?.email || "",
    carrier: initial?.sold?.carrier || "",
    faceAmount: initial?.sold?.faceAmount || "",
    premium: initial?.sold?.premium || "",           // AP stored here
    monthlyPayment: initial?.sold?.monthlyPayment || "",
    policyNumber: initial?.sold?.policyNumber || "",
    startDate: initial?.sold?.startDate || "",
    // (no more local "sendWelcomeText" flag)
    enableBdayHolidayTexts: true,
  });

  function pickClient(id) {
    const c = allClients.find(x => x.id === id);
    if (!c) return;
    setForm((f) => ({
      ...f,
      id: c.id,
      name: c.name || f.name,
      phone: c.phone || f.phone,
      email: c.email || f.email,
    }));
  }

  function submit(e) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
      <div className="relative m-auto w-full max-w-xl rounded-2xl border border-white/15 bg-neutral-950 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-base font-semibold">Mark as SOLD</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10">Close</button>
        </div>

        {/* Quick pick existing lead */}
        <div className="mb-3">
          <label className="text-xs text-white/70">Select existing lead (optional)</label>
          <select
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            onChange={(e) => e.target.value && pickClient(e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>Choose from Leads…</option>
            {allClients.map(c => (
              <option key={c.id} value={c.id}>
                {c.name || c.email || c.phone || c.id}
              </option>
            ))}
          </select>
        </div>

        <form onSubmit={submit} className="grid gap-3">
          {/* Contact */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})}
                     className="inp" placeholder="Jane Doe" />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={(e)=>setForm({...form, phone:e.target.value})}
                     className="inp" placeholder="(555) 123-4567" />
            </Field>
          </div>
          <Field label="Email">
            <input value={form.email} onChange={(e)=>setForm({...form, email:e.target.value})}
                   className="inp" placeholder="jane@example.com" />
          </Field>

          {/* Policy core */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Carrier sold">
              <input value={form.carrier} onChange={(e)=>setForm({...form, carrier:e.target.value})}
                     className="inp" placeholder="Mutual of Omaha" />
            </Field>
            <Field label="Face amount">
              <input value={form.faceAmount} onChange={(e)=>setForm({...form, faceAmount:e.target.value})}
                     className="inp" placeholder="250,000" />
            </Field>
            <Field label="AP (Annual premium)">
              <input value={form.premium} onChange={(e)=>setForm({...form, premium:e.target.value})}
                     className="inp" placeholder="3,000" />
            </Field>
            <Field label="Monthly payment">
              <input value={form.monthlyPayment} onChange={(e)=>setForm({...form, monthlyPayment:e.target.value})}
                     className="inp" placeholder="250" />
            </Field>
            <Field label="Policy number">
              <input value={form.policyNumber} onChange={(e)=>setForm({...form, policyNumber:e.target.value})}
                     className="inp" placeholder="ABC123456789" />
            </Field>
            <Field label="Policy start date">
              <input type="date" value={form.startDate} onChange={(e)=>setForm({...form, startDate:e.target.value})}
                     className="inp" />
            </Field>
          </div>

          {/* Options */}
          <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-3">
            <div className="mb-2 text-sm font-semibold text-white/90">Post-sale options</div>
            <div className="grid gap-2">
              <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3 hover:bg-white/[0.06]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.enableBdayHolidayTexts}
                  onChange={(e)=>setForm({...form, enableBdayHolidayTexts:e.target.checked})}
                />
                <div className="flex-1">
                  <div className="text-sm">Bday Texts + Holiday Texts</div>
                  <p className="mt-1 text-xs text-white/50">
                    Opt-in to automated birthday &amp; holiday greetings.
                  </p>
                </div>
              </label>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10">
              Cancel
            </button>
            <button type="submit"
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90">
              Save as SOLD
            </button>
          </div>
        </form>
      </div>

      <style>{`.inp{width:100%; border-radius:0.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.5rem .75rem; outline:none}
        .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
    </div>
  );
}

/* --------------------------- Manual Add Lead Modal --------------------------- */
function ManualAddLeadModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    dob: "",
    state: "",
    beneficiary: "",
    beneficiary_name: "",
    gender: "",
    military_branch: "",
  });

  function submit(e) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
      <div className="relative m-auto w-full max-w-xl rounded-2xl border border-white/15 bg-neutral-950 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-base font-semibold">Add lead</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10">Close</button>
        </div>

        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input
                className="inp"
                placeholder="Jane Doe"
                value={form.name}
                onChange={(e)=>setForm({...form, name:e.target.value})}
              />
            </Field>
            <Field label="Phone">
              <input
                className="inp"
                placeholder="(555) 123-4567"
                value={form.phone}
                onChange={(e)=>setForm({...form, phone:e.target.value})}
              />
            </Field>
          </div>

          <Field label="Email">
            <input
              className="inp"
              placeholder="jane@example.com"
              value={form.email}
              onChange={(e)=>setForm({...form, email:e.target.value})}
            />
          </Field>

          <Field label="Notes">
            <input
              className="inp"
              placeholder="Any context about the lead"
              value={form.notes}
              onChange={(e)=>setForm({...form, notes:e.target.value})}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="DOB">
              <input
                className="inp"
                placeholder="MM-DD-YYYY"
                value={form.dob}
                onChange={(e)=>setForm({...form, dob:e.target.value})}
              />
            </Field>
            <Field label="State">
              <input
                className="inp"
                placeholder="TN"
                value={form.state}
                onChange={(e)=>setForm({...form, state:e.target.value.toUpperCase()})}
              />
            </Field>
            <Field label="Beneficiary">
              <input
                className="inp"
                value={form.beneficiary}
                onChange={(e)=>setForm({...form, beneficiary:e.target.value})}
              />
            </Field>
            <Field label="Beneficiary Name">
              <input
                className="inp"
                value={form.beneficiary_name}
                onChange={(e)=>setForm({...form, beneficiary_name:e.target.value})}
              />
            </Field>
            <Field label="Gender">
              <input
                className="inp"
                value={form.gender}
                onChange={(e)=>setForm({...form, gender:e.target.value})}
              />
            </Field>
            <Field label="Military Branch">
              <input
                className="inp"
                placeholder="Army / Navy / …"
                value={form.military_branch}
                onChange={(e)=>setForm({...form, military_branch:e.target.value})}
              />
            </Field>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10">
            Cancel
            </button>
            <button type="submit"
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90">
              Save lead
            </button>
          </div>
        </form>
      </div>

      <style>{`.inp{width:100%; border-radius:0.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.5rem .75rem; outline:none}
        .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="text-sm">
      <div className="mb-1 text-white/70">{label}</div>
      {children}
    </label>
  );
}
