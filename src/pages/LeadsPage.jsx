// File: src/pages/LeadsPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { toE164 } from "../lib/phone.js";
import { startCall } from "../lib/calls";

// Optional server helpers (kept so your existing functions continue to work)
import { upsertLeadServer, deleteLeadServer } from "../lib/supabaseLeads.js";

// Controls (assumed to write to Supabase; realtime will update this page)
import AddLeadControl from "../components/leads/AddLeadControl.jsx";
import CsvImportControl from "../components/leads/CsvImportControl.jsx";

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
const STAGE_IDS = ["no_pickup","answered","quoted","app_started","app_pending","app_submitted"];

/* ------------------------ Small helpers ----------------------- */
const PhoneMono = ({ children }) => <span className="font-mono whitespace-nowrap">{children}</span>;
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");

/* -------------------- Contacts helpers (for cleanup/tagging) -------------------- */
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);
const normalizePhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; // drop leading US '1'
};
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
async function upsertSoldContact({ userId, phone, fullName, addBdayHoliday, addPaymentReminder }) {
  if (!phone) return;
  const phoneE164 = toE164(phone);
  if (!phoneE164) throw new Error(`Invalid phone: ${phone}`);

  const existing = await findContactByUserAndPhone(userId, phone);
  const buildSoldTags = (currentTags) => {
    const base = (currentTags || []).filter((t) => !["lead","military","sold"].includes(normalizeTag(t)));
    const out = [...base, "sold"];
    if (addBdayHoliday) out.push("birthday_text", "holiday_text");
    if (addPaymentReminder) out.push("payment_reminder");
    return uniqTags(out);
  };

  if (existing) {
    const nextTags = buildSoldTags(existing.tags);
    const { error } = await supabase
      .from("message_contacts")
      .update({ phone: phoneE164, full_name: fullName || existing.full_name || null, tags: nextTags })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  } else {
    const nextTags = buildSoldTags([]);
    const { data, error } = await supabase
      .from("message_contacts")
      .insert([{ user_id: userId, phone: phoneE164, full_name: fullName || null, tags: nextTags }])
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
}
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
  for (const p of phones || []) for (const v of buildPhoneVariants(p)) allVariants.add(v);
  const list = Array.from(allVariants);
  if (!list.length) return;
  const { error } = await supabase
    .from("message_contacts")
    .delete()
    .eq("user_id", userId)
    .in("phone", list);
  if (error) throw error;
}

/* -------------------- Messages-send function base -------------------- */
const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/* -------------------- SOLD auto-text (tries common keys) -------------------- */
async function sendSoldAutoText({ leadId }) {
  try {
    const [{ data: authUser }, { data: sess }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ]);
    const userId = authUser?.user?.id;
    const token = sess?.session?.access_token;
    if (!userId || !leadId) return;

    const tryKeys = ["sold","sold_welcome","policy_info","sold_policy","policy"];
    for (const templateKey of tryKeys) {
      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ requesterId: userId, lead_id: leadId, templateKey }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && (out?.ok || out?.deduped)) return;
      if (out?.status === "skipped_disabled" || out?.error === "template_not_found") continue;
      break;
    }
  } catch {}
}

/* =============================================================================
   Inbound Webhook Drawer Panel
   - Fetches/creates via /.netlify/functions/user-webhook (GET)
   - Rotates via POST { rotate: true }
   - Username = response.id ; Password = response.secret
============================================================================= */
function InboundWebhookPanel() {
  const [username, setUsername] = useState(""); // webhook row id
  const [secret, setSecret] = useState("");     // webhook secret
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState({ u: false, p: false, e: false, addr: false });

  const ENDPOINT = import.meta.env?.VITE_LEADS_INBOUND_URL || "/.netlify/functions/inbound-leads";
  const LEADS_EMAIL = "remiecrmleads@gmail.com";

  // Load (and create if missing) using your Netlify function
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const { data: sess } = await supabase.auth.getSession();
        const token = sess?.session?.access_token;
        if (!token) {
          setUsername(""); setSecret("");
          return;
        }
        const res = await fetch("/.netlify/functions/user-webhook", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.id) {
          setUsername(""); setSecret("");
          return;
        }
        setUsername(json.id);
        setSecret(json.secret || "");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function copy(val, k) {
    try {
      navigator.clipboard.writeText(val);
      setCopied((c) => ({ ...c, [k]: true }));
      setTimeout(() => setCopied((c) => ({ ...c, [k]: false })), 1200);
    } catch {}
  }

  async function rotateSecret() {
    try {
      setBusy(true);
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      const res = await fetch("/.netlify/functions/user-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rotate: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.secret) throw new Error(json?.error || "Rotate failed");
      // API returns the same id (active row), with a new secret
      setUsername(json.id || username);
      setSecret(json.secret);
    } catch (e) {
      alert(e.message || "Could not rotate password.");
    } finally {
      setBusy(false);
    }
  }

  const endpointUrl = `${window.location.origin}${ENDPOINT}`;
  const curl = `curl -X POST '${endpointUrl}' \\
  -u '${username || "<username>"}:${secret || "<password>"}' \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"Jane Doe","phone":"(555) 123-4567","email":"jane@example.com","state":"TX"}'`;

  const mailtoHref = `mailto:${LEADS_EMAIL}?subject=${encodeURIComponent("Auto-Import Leads setup")}&body=${encodeURIComponent(
    [
      "Hi — please set up auto-import for my Google Sheet.",
      "",
      "Lead type(s): (e.g., FEX, Veteran, EG)",
      "CRM login email: ",
      `Username: ${username || "<will appear after login>"}`,
      `Password: ${secret ? secret : "<rotate and paste here>"}`,
      `Endpoint: ${endpointUrl}`,
      "Google Sheet name + link: ",
      "",
      "Thanks!",
    ].join("\n")
  )}`;

  return (
    <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-4">
      <div className="mb-2 text-base font-semibold">Auto-Import Leads</div>
      <p className="mb-4 text-sm text-white/70">
        Send leads straight into Remie via webhook. Authenticate with <b>Basic Auth</b> using your Username &amp; Password.
      </p>

      {/* Credentials */}
      <div className="grid gap-3 md:grid-cols-[160px_1fr_auto] items-center">
        <div className="text-xs text-white/60">Username</div>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={loading ? "Loading…" : username || "—"}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => copy(username, "u")}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
            disabled={!username}
          >
            {copied.u ? "Copied!" : "Copy"}
          </button>
        </div>
        <div />

        <div className="text-xs text-white/60">Password</div>
        <div className="flex items-center gap-2">
          <input
            readOnly
            type="password"
            value={loading ? "" : secret}
            placeholder={loading ? "Loading…" : secret ? "********" : "No password yet"}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => copy(secret, "p")}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
            disabled={!secret}
          >
            {copied.p ? "Copied!" : "Copy"}
          </button>
        </div>
        <div className="flex gap-2">
          {!!username && (
            <button
              type="button"
              onClick={rotateSecret}
              disabled={busy}
              className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
              title="Rotate password"
            >
              {busy ? "Working…" : "Rotate"}
            </button>
          )}
        </div>

        <div className="text-xs text-white/60 mt-3 md:mt-0">Endpoint</div>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={endpointUrl}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => copy(endpointUrl, "e")}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
          >
            {copied.e ? "Copied!" : "Copy"}
          </button>
        </div>
        <div />
      </div>

      {/* Example */}
      <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3 text-xs">
        <div className="mb-1 font-medium text-white/80">Example</div>
        <pre className="whitespace-pre-wrap break-all text-white/70">{curl}</pre>
      </div>

      {/* Steps */}
      <div className="mt-5 rounded-xl border border-white/10 bg-gradient-to-r from-black/40 to-black/10 p-4">
        <div className="font-medium mb-2">Steps:</div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Share your Google Sheet with{" "}
            <span className="font-mono">remiecrmleads@gmail.com</span>.
          </li>
          <li>
            Email me the details:
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Lead type(s) — e.g., FEX, Veteran, EG</li>
              <li>CRM login email</li>
              <li><b>Username</b> &amp; <b>Password</b> (shown above)</li>
              <li>Google Sheet name + link</li>
            </ul>
          </li>
        </ol>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => copy(LEADS_EMAIL, "addr")}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          >
            {copied.addr ? "Copied!" : "Copy email address"}
          </button>
          <a
            href={mailtoHref}
            className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-black hover:bg-white/90"
          >
            Compose email
          </a>
        </div>

        <p className="mt-2 text-xs text-white/50">
          I’ll complete setup and email you when it’s done. After that, new rows in your sheet will auto-import into Remie.
        </p>
      </div>
    </div>
  );
}

/* =============================================================================
   Main Component
============================================================================= */
export default function LeadsPage() {
  const [tab, setTab] = useState("clients"); // 'clients' | 'sold'
  const [rows, setRows] = useState([]);      // <-- SINGLE SOURCE OF TRUTH (Supabase)
  const [filter, setFilter] = useState("");
  const [serverMsg, setServerMsg] = useState("");
  const [showConnector, setShowConnector] = useState(false);

  // call and stage UI
  const [agentPhone, setAgentPhone] = useState("");
  const [editingStageId, setEditingStageId] = useState(null);
  const stageSelectRef = useRef(null);

  // SOLD drawers
  const [selected, setSelected] = useState(null);
  const [viewSelected, setViewSelected] = useState(null);

  // selection for bulk actions
  const [selectedIds, setSelectedIds] = useState(new Set());

  /* -------------------- Initial fetch (Supabase only) -------------------- */
  useEffect(() => {
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        const { data, error } = await supabase
          .from("leads")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        setRows(data || []);
      } catch (e) {
        console.error("Initial fetch failed:", e);
        setServerMsg(`⚠️ Failed to load leads: ${e.message || e}`);
      }
    })();
  }, []);

  /* -------------------- Realtime (INSERT/UPDATE/DELETE) -------------------- */
  useEffect(() => {
    let channel;
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        channel = supabase.channel("leads_changes")
          .on("postgres_changes",
            { event: "INSERT", schema: "public", table: "leads", filter: `user_id=eq.${userId}` },
            (payload) => {
              setRows((prev) => {
                if (prev.some((r) => r.id === payload.new.id)) return prev;
                return [payload.new, ...prev];
              });
              setServerMsg("✅ New lead arrived");
            }
          )
          .on("postgres_changes",
            { event: "UPDATE", schema: "public", table: "leads", filter: `user_id=eq.${userId}` },
            (payload) => {
              setRows((prev) => prev.map((r) => (r.id === payload.new.id ? payload.new : r)));
            }
          )
          .on("postgres_changes",
            { event: "DELETE", schema: "public", table: "leads", filter: `user_id=eq.${userId}` },
            (payload) => {
              setRows((prev) => prev.filter((r) => r.id !== payload.old.id));
            }
          )
          .subscribe();
      } catch (e) {
        console.error("Realtime subscribe failed:", e);
      }
    })();
    return () => { if (channel) supabase.removeChannel(channel); };
  }, []);

  /* -------------------- Load agent phone (for click-to-call) -------------------- */
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

  /* -------------------- Click-to-call -------------------- */
  async function onCallLead(leadNumber, contactId) {
    try {
      const to = toE164(leadNumber);
      if (!to) return alert("Invalid lead phone.");
      let fromAgent = agentPhone;
      if (!fromAgent) {
        const p = prompt("Enter your phone (we call you first):", "+1 ");
        if (!p) return;
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

  /* -------------------- Local patcher (UI-only, source of truth is Supabase) -------------------- */
  function patchLocalLead(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch, pipeline: { ...(r.pipeline || {}) } } : r)));
  }

  /* -------------------- Stage change (persist to Supabase) -------------------- */
  async function saveStageChange(id, newStage) {
    try {
      const nowISO = new Date().toISOString();
      patchLocalLead(id, { stage: newStage, stage_changed_at: nowISO }); // optimistic
      const current = rows.find((x) => x.id === id) || { id };
      const payload = { ...current, stage: newStage, stage_changed_at: nowISO };
      setServerMsg("Updating stage…");
      await upsertLeadServer(payload);
      setServerMsg("✅ Stage updated");
    } catch (e) {
      console.error("Stage save failed:", e);
      setServerMsg(`⚠️ Stage update failed: ${e.message || e}`);
    } finally {
      setEditingStageId(null);
    }
  }

  /* -------------------- Delete single (Supabase + Contacts) -------------------- */
  async function removeOne(id) {
    if (!confirm("Delete this record? This deletes from Supabase and removes the matching Contact.")) return;
    const rec = rows.find((r) => r.id === id);
    const phone = rec?.phone;

    // Optimistic UI
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (selected?.id === id) setSelected(null);

    try {
      setServerMsg("Deleting on Supabase…");
      await deleteLeadServer(id);
      setServerMsg("🗑️ Deleted lead in Supabase");
    } catch (e) {
      console.error("Delete server error:", e);
      setServerMsg(`⚠️ Could not delete lead on Supabase: ${e.message || e}`);
    }

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

  /* -------------------- Selection helpers & bulk delete -------------------- */
  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const visibleIds = visible.map((v) => v.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      if (allSelected) { for (const id of visibleIds) next.delete(id); }
      else { for (const id of visibleIds) next.add(id); }
      return next;
    });
  }
  async function removeSelected() {
    const idsToDelete = visible.filter((v) => selectedIds.has(v.id)).map((v) => v.id);
    if (!idsToDelete.length) return;
    if (!confirm(`Delete ${idsToDelete.length} selected record(s)? This deletes from Supabase and removes matching Contacts.`)) {
      return;
    }

    const phoneById = new Map(rows.filter((r) => idsToDelete.includes(r.id)).map((r) => [r.id, r.phone]));

    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (!userId) {
        setServerMsg("⚠️ Not logged in.");
        return;
      }
      setServerMsg(`Deleting ${idsToDelete.length} on server…`);
      const { data, error } = await supabase
        .from("leads")
        .delete()
        .eq("user_id", userId)
        .in("id", idsToDelete)
        .select("id");
      if (error) {
        console.error("Bulk delete error:", error);
        setServerMsg(`⚠️ Server delete failed: ${error.message || error}`);
        return;
      }

      const deletedIds = new Set((data || []).map((r) => r.id));
      setRows((prev) => prev.filter((r) => !deletedIds.has(r.id)));
      setSelectedIds(new Set());
      setSelected(null);

      try {
        const phonesToDelete = Array.from(deletedIds).map((id) => phoneById.get(id)).filter(Boolean);
        if (phonesToDelete.length) await deleteContactsByPhones(userId, phonesToDelete);
      } catch (e) {
        console.warn("Contact bulk delete failed:", e);
      }

      const missed = idsToDelete.length - deletedIds.size;
      setServerMsg(missed > 0
        ? `⚠️ Deleted ${deletedIds.size}, ${missed} not deleted (server skipped).`
        : `🗑️ Deleted ${deletedIds.size} selected (and matching contacts).`
      );
    } catch (e) {
      console.error("Bulk delete fatal:", e);
      setServerMsg(`⚠️ Delete failed: ${e.message || e}`);
    }
  }

  /* -------------------- SOLD save (persist to Supabase only) -------------------- */
  async function saveSoldInfo(id, form) {
    try {
      setServerMsg("Saving SOLD info…");
      const current = rows.find((x) => x.id === id) || { id };
      const sold = {
        carrier: String(form.carrier || "").trim() || null,
        faceAmount: String(form.faceAmount || "").trim() || null,
        premium: String(form.premium || "").trim() || null,
        monthlyPayment: String(form.monthlyPayment || "").trim() || null,
        policyNumber: String(form.policyNumber || "").trim() || null,
        startDate: String(form.startDate || "").trim() || null,
        name: String(form.name || current.name || "").trim() || null,
        phone: String(form.phone || current.phone || "").trim() || null,
        email: String(form.email || current.email || "").trim() || null,
      };
      const payload = { ...current, id, status: "sold", sold, updated_at: new Date().toISOString() };

      await upsertLeadServer(payload);                   // persist
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "sold", sold } : r))); // reflect

      try {
        const { data: auth } = await supabase.auth.getUser();
        const userId = auth?.user?.id;
        if (userId) {
          await upsertSoldContact({
            userId,
            phone: sold.phone || current.phone,
            fullName: sold.name || current.name,
            addBdayHoliday: !!form.enableBdayHolidayTexts,
            addPaymentReminder: false,
          });
        }
      } catch (e) {
        console.warn("[sold] contact upsert failed:", e?.message || e);
      }

      try { await sendSoldAutoText({ leadId: id }); } catch {}
      setServerMsg("✅ Saved SOLD info");
      setSelected(null);
    } catch (e) {
      console.error("saveSoldInfo failed:", e);
      setServerMsg(`⚠️ Could not save SOLD info: ${e.message || e}`);
    }
  }

  /* -------------------- Derived lists (purely from Supabase rows) -------------------- */
  const onlySold  = useMemo(() => rows.filter((c) => c.status === "sold"), [rows]);
  const visible = useMemo(() => {
    const src = tab === "clients" ? rows : onlySold;
    const q = filter.trim().toLowerCase();
    return q
      ? src.filter((r) =>
          [r.name, r.email, r.phone, r.state, r.gender, r.beneficiary_name, r.military_branch, labelForStage(r.stage)]
            .some((v) => (v || "").toString().toLowerCase().includes(q))
        )
      : src;
  }, [tab, rows, onlySold, filter]);

  // close stage select if clicking outside
  useEffect(() => {
    function onDocClick(e) {
      if (!stageSelectRef.current) return;
      if (!stageSelectRef.current.contains(e.target)) setEditingStageId(null);
    }
    if (editingStageId) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [editingStageId]);

  /* -------------------- Render -------------------- */
  const baseHeaders = ["Name","Phone","Email","DOB","State","Beneficiary","Beneficiary Name","Gender","Military Branch","Stage"];
  const colCount = baseHeaders.length + 2; // + Select + Actions

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
          title="Auto-import leads setup"
        >
          {showConnector ? "Close setup" : "Setup auto import"}
        </button>

        <div className="ml-auto flex items-center gap-3">
          <AddLeadControl
            onAddedLocal={() => { /* no-op; realtime will update */ }}
            onServerMsg={(s) => setServerMsg(s)}
          />
          <CsvImportControl
            onAddedLocal={() => { /* no-op; realtime will update */ }}
            onServerMsg={(s) => setServerMsg(s)}
          />
          <button
            onClick={removeSelected}
            disabled={selectedIds.size === 0}
            className={`rounded-xl border ${selectedIds.size ? "border-rose-500/60 bg-rose-500/10" : "border-white/10 bg-white/5"} px-3 py-2 text-sm`}
            title="Delete selected leads (Supabase + Contacts)"
          >
            Delete selected ({selectedIds.size})
          </button>
        </div>
      </div>

      {serverMsg && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/80">
          {serverMsg}
        </div>
      )}

      {showConnector && (
        <div id="auto-import-panel" className="my-4 rounded-2xl border border-white/15 bg-white/[0.03] p-4">
          <InboundWebhookPanel />
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
              const stageLabelTxt = labelForStage(stageId);
              const stageClass = STAGE_STYLE[stageId] || "bg-white/10 text-white/80";
              const isEditingThis = editingStageId === p.id;

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

                  {/* Phone with call button */}
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

                  {/* Stage */}
                  <Td>
                    {isSold ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                        Sold
                      </span>
                    ) : (
                      <div ref={isEditingThis ? stageSelectRef : null} className="relative inline-block">
                        {!isEditingThis ? (
                          <button
                            onClick={() => setEditingStageId(p.id)}
                            className={`rounded-full px-2 py-0.5 text-xs ${stageClass}`}
                            title="Click to change stage"
                          >
                            {stageLabelTxt}
                          </button>
                        ) : (
                          <select
                            autoFocus
                            value={stageId}
                            onChange={(e) => saveStageChange(p.id, e.target.value)}
                            onBlur={() => setEditingStageId(null)}
                            className="rounded-full border border-white/15 bg-black/60 px-2 py-1 text-xs outline-none"
                          >
                            {STAGE_IDS.map(sid => (
                              <option key={sid} value={sid}>{labelForStage(sid)}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </Td>

                  <Td>
                    <div className="flex items-center gap-2">
                      {tab === "clients" ? (
                        <button
                          onClick={() => setSelected(p)}
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
                        title="Delete (Supabase + Contact)"
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
          allClients={rows}
          onClose={() => setSelected(null)}
          onSave={(payload) => saveSoldInfo(payload.id, payload)}
        />
      )}

      {/* Read-only policy viewer for SOLD rows */}
      {viewSelected && (
        <PolicyViewer person={viewSelected} onClose={() => setViewSelected(null)} />
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

      <style>{`.inp{width:100%; border-radius:.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.5rem .75rem; outline:none}
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
