// File: src/pages/MessageTestPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

/* Netlify Functions base */
const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/* ---- Helpers ---- */
const S = (x) => (x == null ? "" : String(x).trim());

function normalizeToE164_US_CA(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const compact = trimmed.replace(/\s+/g, "");
    return /^\+\d{10,15}$/.test(compact) ? compact : null;
  }
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);
const normalizePhoneKey = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; // 10-digit key
};

function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

function extractTemplateMap(mt) {
  if (!mt) return {};
  const out = {};
  // Preferred JSON blob
  if (mt.templates && typeof mt.templates === "object") {
    for (const [k, v] of Object.entries(mt.templates)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
  }
  // Accept legacy top-level columns
  const candidates = ["new_lead","new_lead_military","follow_up_2d","birthday","holiday","payment_reminder","sold_welcome"];
  for (const k of candidates) {
    if (typeof mt[k] === "string" && mt[k].trim()) out[k] = mt[k];
  }
  return out;
}

export default function MessageTestPage() {
  const { user } = useAuth();
  const allowed = (user?.email || "").toLowerCase() === "jacobprieto@gmail.com";

  const [loading, setLoading] = useState(true);
  const [mt, setMt] = useState(null);
  const [agent, setAgent] = useState(null);

  const [toNumber, setToNumber] = useState("");
  const [selectedKey, setSelectedKey] = useState(""); // includes synthetic automation options
  const [sending, setSending] = useState(false);
  const [serverMsg, setServerMsg] = useState("");

  // Context for rendering
  const [ctx, setCtx] = useState({
    first_name: "",
    name: "",
    state: "TN",
    beneficiary: "your spouse",
    agent_name: "",
    agent_phone: "",
    calendly_link: "",
  });

  // Load templates + agent profile
  useEffect(() => {
    (async () => {
      if (!allowed || !user?.id) return;
      setLoading(true);
      try {
        const [{ data: mtRow }, { data: agentRow }] = await Promise.all([
          supabase.from("message_templates").select("*").eq("user_id", user.id).maybeSingle(),
          supabase.from("agent_profiles").select("full_name, phone, calendly_url").eq("user_id", user.id).maybeSingle(),
        ]);
        setMt(mtRow || null);
        setAgent(agentRow || null);

        const agent_name = S(agentRow?.full_name);
        const agent_phone = S(agentRow?.phone);
        const calendly_link = S(agentRow?.calendly_url);

        setCtx((c) => ({
          ...c,
          name: c.name || "John Doe",
          first_name: (c.name || "John").split(/\s+/)[0],
          agent_name: agent_name || c.agent_name,
          agent_phone: agent_phone || c.agent_phone,
          calendly_link: calendly_link || c.calendly_link,
        }));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [allowed, user?.id]);

  const rawTemplates = useMemo(() => extractTemplateMap(mt), [mt]);

  // Build unified dropdown: normal templates + automation scenarios (if follow_up_2d exists)
  const dropdownOptions = useMemo(() => {
    const opts = Object.keys(rawTemplates).map((k) => ({ key: k, label: k, type: "template" }));
    if (rawTemplates["follow_up_2d"]) {
      opts.push(
        { key: "auto_follow_up_2d__lead", label: "No-reply follow-up (lead)", type: "automation" },
        { key: "auto_follow_up_2d__military", label: "No-reply follow-up (military)", type: "automation" },
      );
    }
    return opts;
  }, [rawTemplates]);

  // Choose first option by default
  useEffect(() => {
    if (!selectedKey && dropdownOptions.length) setSelectedKey(dropdownOptions[0].key);
  }, [dropdownOptions, selectedKey]);

  // Which template text to render?
  const effectiveTemplateText = useMemo(() => {
    if (!selectedKey) return "";
    if (selectedKey.startsWith("auto_follow_up_2d__")) {
      return rawTemplates["follow_up_2d"] || "";
    }
    return rawTemplates[selectedKey] || "";
  }, [selectedKey, rawTemplates]);

  const preview = useMemo(() => renderTemplate(effectiveTemplateText, ctx), [effectiveTemplateText, ctx]);

  // --- Contact tag mutation used by automation scenarios ---
  async function ensureExclusiveStatusTag(mode /* "lead" | "military" */) {
    if (!user?.id) throw new Error("Not signed in.");
    const e164 = normalizeToE164_US_CA(toNumber);
    if (!e164) throw new Error("Enter a valid test number first.");
    const key10 = normalizePhoneKey(e164);

    const { data: contacts, error } = await supabase
      .from("message_contacts")
      .select("id, phone, full_name, tags")
      .eq("user_id", user.id);
    if (error) throw error;
    const existing = (contacts || []).find((c) => normalizePhoneKey(c.phone) === key10);

    const current = Array.isArray(existing?.tags) ? existing.tags : [];
    const withoutStatus = current.filter((t) => !["lead", "military"].includes(normalizeTag(t)));
    const next = uniqTags([...withoutStatus, mode]); // exclusive

    if (existing?.id) {
      const { error: uErr } = await supabase
        .from("message_contacts")
        .update({ full_name: ctx.name || existing.full_name || null, tags: next })
        .eq("id", existing.id);
      if (uErr) throw uErr;
      return existing.id;
    } else {
      const { data: ins, error: iErr } = await supabase
        .from("message_contacts")
        .insert([{ user_id: user.id, phone: e164, full_name: ctx.name || null, tags: next }])
        .select("id")
        .single();
      if (iErr) throw iErr;
      return ins.id;
    }
  }

  // --- Send current selection ---
  async function handleSendSelected() {
    const e164 = normalizeToE164_US_CA(toNumber);
    if (!e164) return alert("Enter a valid US/CA number (e.g. +16155551234).");

    const text = renderTemplate(effectiveTemplateText, ctx).trim();
    if (!text) return alert("Template rendered empty. Adjust context.");

    setSending(true);
    setServerMsg("");

    try {
      let client_ref = null;

      // If this is an automation scenario, enforce tag + set client_ref
      if (selectedKey === "auto_follow_up_2d__lead") {
        await ensureExclusiveStatusTag("lead");
        client_ref = "followup_2d";
      } else if (selectedKey === "auto_follow_up_2d__military") {
        await ensureExclusiveStatusTag("military");
        client_ref = "followup_2d";
      }

      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          to: e164,
          body: text,
          requesterId: user?.id || null,
          lead_id: null,
          ...(client_ref ? { client_ref } : {}), // tag rows for follow-up dedupe if applicable
        }),
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.error) {
        throw new Error(out?.telnyx_response?.errors?.[0]?.detail || out?.error || "Send failed");
      }
      setServerMsg(`✅ Sent (id: ${out.telnyx_id || "n/a"})`);
    } catch (e) {
      console.error(e);
      setServerMsg(`❌ ${e.message || e}`);
    } finally {
      setSending(false);
    }
  }

  // --- UI ---
  if (!allowed) {
    return (
      <div className="min-h-[60vh] grid place-items-center">
        <div className="rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-sm">
          403 — Not authorized
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        Loading Message Lab…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-xl font-semibold">Message Lab (private)</div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Left: controls */}
        <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-4 space-y-3">
          <div className="text-sm font-medium">Destination</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            placeholder="+16155551234"
            value={toNumber}
            onChange={(e)=>setToNumber(e.target.value)}
          />

          <div className="mt-2 text-sm font-medium">Context</div>
          <div className="grid gap-2 md:grid-cols-2">
            {[
              ["name","Lead full name"],
              ["first_name","First name"],
              ["state","State (e.g., TN)"],
              ["beneficiary","Beneficiary"],
              ["agent_name","Agent name"],
              ["agent_phone","Agent phone"],
              ["calendly_link","Calendly link"],
            ].map(([k,label]) => (
              <label key={k} className="text-xs">
                <div className="mb-1 text-white/70">{label}</div>
                <input
                  className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
                  value={ctx[k]}
                  onChange={(e)=>setCtx({...ctx, [k]: e.target.value})}
                />
              </label>
            ))}
          </div>

          <div className="mt-3 text-sm font-medium">What to send</div>
          {dropdownOptions.length === 0 ? (
            <div className="text-sm text-white/60">No templates found for your account.</div>
          ) : (
            <>
              <select
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
                value={selectedKey}
                onChange={(e)=>setSelectedKey(e.target.value)}
              >
                {dropdownOptions.map(opt => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  onClick={handleSendSelected}
                  disabled={sending || !toNumber.trim()}
                  className="rounded-xl border border-white/15 bg-white text-black px-3 py-2 text-sm disabled:opacity-50"
                >
                  Send
                </button>
              </div>

              {serverMsg && (
                <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/80">
                  {serverMsg}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: preview */}
        <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-4">
          <div className="text-sm font-medium mb-2">Rendered preview</div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm whitespace-pre-wrap">
            {preview || "—"}
          </div>
          {selectedKey && (
            <div className="mt-3 text-xs text-white/50">
              Selected: <code className="text-white/70">{dropdownOptions.find(o=>o.key===selectedKey)?.label}</code>
              {selectedKey.startsWith("auto_follow_up_2d__") && (
                <span className="ml-1 text-white/50">
                  &nbsp;• This uses your <code>follow_up_2d</code> template and sets the contact tag accordingly.
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-white/50">
        Note: The live 2-day automation keeps sending this <code>follow_up_2d</code> message every 2 days (per your scheduled function)
        until the contact replies. This tester just sends a single instance now, with the same tag/row semantics.
      </div>
    </div>
  );
}
