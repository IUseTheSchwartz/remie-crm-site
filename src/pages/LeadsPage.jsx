// File: src/pages/LeadsPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { toE164 } from "../lib/phone.js";
import { startCall } from "../lib/calls";

// Optional server helpers (kept so your existing functions continue to work)
import { upsertLeadServer, deleteLeadServer } from "../lib/supabaseLeads.js";

// Controls (assumed to write to Supabase; realtime will update this page)
// import AddLeadControl from "../components/leads/AddLeadControl.jsx"; // REMOVED
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
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Remie-Billing": "free_first",
        },
        body: JSON.stringify({
          requesterId: userId,
          lead_id: leadId,
          templateKey,
          billing: "free_first",
          preferFreeSegments: true,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && (out?.ok || out?.deduped)) return;
      if (out?.status === "skipped_disabled" || out?.error === "template_not_found") continue;
      break;
    }
  } catch {}
}

/* =============================================================================
   Inbound Webhook Drawer Panel (unchanged)
============================================================================= */
function InboundWebhookPanel() {
  const [username, setUsername] = useState(""); // webhook row id
  const [secret, setSecret] = useState("");     // webhook secret
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState({ u: false, p: false, addr: false });

  const LEADS_EMAIL = "remiecrmleads@gmail.com";

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
        <div />
      </div>

      {/* Steps (simplified) */}
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
              <li>Google Sheet name</li>
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

  // ----- Auto Dial UI state -----
  const [showAutoDial, setShowAutoDial] = useState(false);
  const [queue, setQueue] = useState([]); // [{id, attempts, status}]
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(1); // 1 | 2 | 3
  const [stateFilter, setStateFilter] = useState(""); // comma or space-separated (e.g., "TN, FL")
  const [onlyNoPickup, setOnlyNoPickup] = useState(true);

  // live per-lead status (UI badges) → string: "queued" | "dialing" | "ringing" | "answered" | "bridged" | "completed" | "failed"
  const [liveStatus, setLiveStatus] = useState({}); // { leadId: status }
  const liveStatusRef = useRef({});
  useEffect(() => { liveStatusRef.current = liveStatus; }, [liveStatus]);

  // Page-scoped global billing hint for any importer that chooses to read it
  useEffect(() => {
    const prev = window.__REMIE_BILLING_HINT__;
    window.__REMIE_BILLING_HINT__ = "free_first";
    return () => { window.__REMIE_BILLING_HINT__ = prev; };
  }, []);

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

  /* -------------------- Prefill latest call status per lead -------------------- */
  useEffect(() => {
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        // Pull the last ~200 call logs for the user and keep the most recent per contact_id
        const { data, error } = await supabase
          .from("call_logs")
          .select("contact_id,status,updated_at,answered_at,started_at,ended_at")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(200);

        if (error) return;

        const latest = new Map();
        for (const r of data || []) {
          if (!r.contact_id || latest.has(r.contact_id)) continue;
          latest.set(r.contact_id, r.status);
        }

        if (latest.size) {
          const obj = {};
          for (const [cid, st] of latest.entries()) {
            obj[cid] =
              st === "ringing" ? "ringing" :
              st === "answered" ? "answered" :
              st === "bridged" ? "bridged" :
              st === "completed" ? "completed" :
              st === "failed" ? "failed" :
              "dialing";
          }
          setLiveStatus((s) => ({ ...obj, ...s })); // keep any already-live states
        }
      } catch {}
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

  /* -------------------- Realtime: call_logs (live status) -------------------- */
  useEffect(() => {
    let chan;
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        chan = supabase.channel("call_logs_live")
          .on("postgres_changes",
            { event: "*", schema: "public", table: "call_logs", filter: `user_id=eq.${userId}` },
            (payload) => {
              const rec = payload.new || payload.old || {};
              const leadId = rec.contact_id;
              if (!leadId) return;

              const status = rec.status || "";
              const mapped =
                status === "ringing" ? "ringing" :
                status === "answered" ? "answered" :
                status === "bridged" ? "bridged" :
                status === "completed" ? "completed" :
                status === "failed" ? "failed" :
                status || "dialing";

              setLiveStatus((s) => ({ ...s, [leadId]: mapped }));

              // Drive the auto-dialer based on end events
              if (isRunningRef.current) {
                if (mapped === "completed" || mapped === "failed") {
                  advanceAfterEnd(leadId, mapped);
                }
              }
            }
          )
          .subscribe();
      } catch (e) {
        console.error("call_logs subscribe failed:", e);
      }
    })();
    return () => { if (chan) supabase.removeChannel(chan); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /* -------------------- Click-to-call (single) -------------------- */
  async function onCallLead(leadNumber, contactId) {
    try {
      const to = toE164(leadNumber);
      if (!to) return alert("Invalid lead phone.");
      const fromAgent = await ensureAgentPhone();
      if (!fromAgent) return;
      await startCall({ agentNumber: fromAgent, leadNumber: to, contactId });
      setServerMsg("📞 Calling…");
      setLiveStatus((s) => ({ ...s, [contactId]: "dialing" }));
    } catch (e) {
      alert(e.message || "Failed to start call");
    }
  }

  async function ensureAgentPhone() {
    let fromAgent = agentPhone;
    if (!fromAgent) {
      const p = prompt("Enter your phone (we call you):", "+1 ");
      if (!p) return null;
      const e164 = toE164(p);
      if (!e164) { alert("That phone doesn’t look valid. Use +1XXXXXXXXXX"); return null; }
      await saveAgentPhone(e164);
      fromAgent = e164;
    }
    return fromAgent;
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

  /* -------------------- Auto Dial: queue builders & runner -------------------- */
  function parseStateFilter(s) {
    // Accept "TN, FL", "tn fl", etc.
    return String(s || "")
      .split(/[\s,]+/)
      .map(x => x.trim().toUpperCase())
      .filter(Boolean);
  }

  function buildQueueFromFilters() {
    const wantStates = new Set(parseStateFilter(stateFilter)); // may be empty (means all)
    const list = (tab === "clients" ? rows : onlySold)
      .filter(r => r.phone)
      .filter(r => (wantStates.size ? wantStates.has((r.state || "").toUpperCase()) : true))
      .filter(r => (onlyNoPickup ? (r.stage ?? "no_pickup") === "no_pickup" : true))
      .map(r => ({ id: r.id, attempts: 0, status: "queued" }));

    setQueue(list);
    setCurrentIdx(0);
    const patch = {};
    for (const q of list) patch[q.id] = "queued";
    setLiveStatus((s) => ({ ...s, ...patch }));
  }

  async function startAutoDial() {
    if (!queue.length) {
      buildQueueFromFilters();
      // allow build to finish in same tick
      setTimeout(() => runNext(), 0);
    } else {
      runNext();
    }
  }

  function stopAutoDial() {
    setIsRunning(false);
    isRunningRef.current = false;
    setServerMsg("⏸️ Auto dial paused");
  }

  async function runNext() {
    const fromAgent = await ensureAgentPhone();
    if (!fromAgent) return;

    setIsRunning(true);
    isRunningRef.current = true;

    const idx = currentIdx;
    if (idx >= queue.length) {
      setIsRunning(false);
      isRunningRef.current = false;
      setServerMsg("✅ Queue finished");
      return;
    }

    const item = queue[idx];
    const lead = rows.find(r => r.id === item.id);
    if (!lead || !lead.phone) {
      // skip and advance
      setCurrentIdx((i) => i + 1);
      setTimeout(runNext, 0);
      return;
    }

    // place call
    try {
      setLiveStatus((s) => ({ ...s, [item.id]: "dialing" }));
      setQueue((q) => q.map((x, i) => i === idx ? { ...x, status: "dialing" } : x));
      const to = toE164(lead.phone);
      await startCall({ agentNumber: fromAgent, leadNumber: to, contactId: lead.id });
      setServerMsg(`📞 Dialing: ${lead.name || lead.phone}`);

      // Safety net: if nothing comes back after timeout (e.g., 70s), advance.
      const leadId = lead.id;
      setTimeout(() => {
        const st = liveStatusRef.current[leadId];
        if (isRunningRef.current && ["dialing","ringing","answered","bridged"].includes(st)) {
          advanceAfterEnd(leadId, "failed");
        }
      }, 70000);
    } catch (e) {
      // immediate failure; decide retry or move on
      advanceAfterEnd(item.id, "failed");
    }
  }

  function advanceAfterEnd(leadId, outcome) {
    setQueue((old) => {
      const idx = currentIdx;
      const cur = old[idx];
      if (!cur || cur.id !== leadId) return old;

      const attempts = (cur.attempts || 0) + 1;
      setLiveStatus((s) => ({ ...s, [leadId]: outcome }));

      if (outcome !== "completed" && attempts < maxAttempts) {
        // re-dial same lead
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: "queued" };
        setServerMsg(`🔁 Re-dial ${attempts + 1}/${maxAttempts}`);
        setTimeout(runNext, 500);
        return updated;
      } else {
        // move to next lead
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: outcome };
        setCurrentIdx((i) => i + 1);
        setTimeout(runNext, 300);
        return updated;
      }
    });
  }

  /* -------------------- Render -------------------- */
  const baseHeaders = ["Name","Phone","Email","DOB","State","Beneficiary","Beneficiary Name","Gender","Military Branch","Stage","Status"];
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

        {/* Auto Dial open */}
        <button
          onClick={() => setShowAutoDial(true)}
          className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm hover:bg-emerald-500/15"
          title="Open Auto Dial"
        >
          Auto Dial
        </button>

        <div className="ml-auto flex items-center gap-3">
          <CsvImportControl
            preferFreeSegments
            billingMode="free_first"
            onSendOptions={{
              billing: "free_first",
              preferFreeSegments: true,
              headers: { "X-Remie-Billing": "free_first" },
            }}
            onAddedLocal={() => {}}
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
        <table className="min-w-[1300px] w-full border-collapse text-sm">
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

              const uiStatus = liveStatus[p.id]; // show live dialing/answered/etc.
              const statusBadge = uiStatus
                ? <span className={`rounded-full px-2 py-0.5 text-xs ${badgeClass(uiStatus)}`}>{cap(uiStatus)}</span>
                : <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">—</span>;

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

                  {/* Live Status */}
                  <Td>{statusBadge}</Td>

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
                  No records yet. Import a CSV to get started.
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

      {/* Auto Dial Modal */}
      {showAutoDial && (
        <AutoDialerModal
          onClose={() => setShowAutoDial(false)}
          stateFilter={stateFilter}
          setStateFilter={setStateFilter}
          onlyNoPickup={onlyNoPickup}
          setOnlyNoPickup={setOnlyNoPickup}
          maxAttempts={maxAttempts}
          setMaxAttempts={setMaxAttempts}
          buildQueue={buildQueueFromFilters}
          queue={queue}
          isRunning={isRunning}
          onStart={startAutoDial}
          onStop={stopAutoDial}
          currentIdx={currentIdx}
          rowsLookup={new Map(rows.map(r => [r.id, r]))}
          liveStatus={liveStatus}
        />
      )}
    </div>
  );
}

function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-2">{children}</td>; }

function badgeClass(status) {
  switch (status) {
    case "queued": return "bg-white/10 text-white/70";
    case "dialing": return "bg-white/10 text-white/80";
    case "ringing": return "bg-amber-500/15 text-amber-300";
    case "answered": return "bg-sky-500/15 text-sky-300";
    case "bridged": return "bg-indigo-500/15 text-indigo-300";
    case "completed": return "bg-emerald-500/15 text-emerald-300";
    case "failed": return "bg-rose-500/15 text-rose-300";
    default: return "bg-white/10 text-white/70";
  }
}
const cap = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());

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

/* ------------------------------ Auto Dial Modal ------------------------------- */
function AutoDialerModal({
  onClose,
  stateFilter, setStateFilter,
  onlyNoPickup, setOnlyNoPickup,
  maxAttempts, setMaxAttempts,
  buildQueue, queue, isRunning, onStart, onStop, currentIdx,
  rowsLookup, liveStatus
}) {
  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-4">
      <div className="relative m-auto w-full max-w-3xl rounded-2xl border border-white/15 bg-neutral-950 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-lg font-semibold">Auto Dial</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10">Close</button>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="col-span-1">
            <label className="text-xs text-white/70">States (comma or space separated)</label>
            <input
              value={stateFilter}
              onChange={(e)=>setStateFilter(e.target.value)}
              placeholder="TN, KY, FL"
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
          </div>
          <div className="col-span-1 flex items-end">
            <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <input type="checkbox" checked={onlyNoPickup} onChange={(e)=>setOnlyNoPickup(e.target.checked)} />
              <span className="text-sm">Only “No Pickup”</span>
            </label>
          </div>
          <div className="col-span-1">
            <label className="text-xs text-white/70">Re-dial attempts</label>
            <select
              value={maxAttempts}
              onChange={(e)=>setMaxAttempts(Number(e.target.value))}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            >
              <option value={1}>Single dial</option>
              <option value={2}>Double dial</option>
              <option value={3}>Triple dial</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={buildQueue}
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          >
            Build queue
          </button>
          {!isRunning ? (
            <button
              onClick={onStart}
              className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm hover:bg-emerald-500/20"
            >
              Start calling
            </button>
          ) : (
            <button
              onClick={onStop}
              className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm hover:bg-amber-500/20"
            >
              Pause
            </button>
          )}
          <div className="text-xs text-white/60 ml-2">
            {queue.length ? `Lead ${Math.min(currentIdx + 1, queue.length)} of ${queue.length}` : "No queue yet"}
          </div>
        </div>

        <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-white/70">
              <tr>
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Lead</th>
                <th className="px-3 py-2 text-left font-medium">Phone</th>
                <th className="px-3 py-2 text-left font-medium">State</th>
                <th className="px-3 py-2 text-left font-medium">Attempts</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {queue.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-white/60">Build a queue to preview calls.</td></tr>
              ) : queue.map((q, i) => {
                const r = rowsLookup.get(q.id) || {};
                const uiStatus = liveStatus[q.id] || q.status || "queued";
                return (
                  <tr key={q.id} className={`border-t border-white/10 ${i === currentIdx ? "bg-white/[0.03]" : ""}`}>
                    <td className="px-3 py-2">{i + 1}</td>
                    <td className="px-3 py-2">{r.name || r.email || r.phone || r.id}</td>
                    <td className="px-3 py-2"><PhoneMono>{r.phone || "—"}</PhoneMono></td>
                    <td className="px-3 py-2">{r.state || "—"}</td>
                    <td className="px-3 py-2">{q.attempts || 0}/{maxAttempts}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badgeClass(uiStatus)}`}>{cap(uiStatus)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}
