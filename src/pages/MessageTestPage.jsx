import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

/* Functions base (Netlify) */
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

// Render {{ var }} with a context object
function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

// Try to collect available template keys from the row
function extractTemplateMap(mt) {
  if (!mt) return {};
  const out = {};
  // Preferred JSON field
  if (mt.templates && typeof mt.templates === "object") {
    for (const [k, v] of Object.entries(mt.templates)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
  }
  // Accept top-level legacy columns (e.g. new_lead, new_lead_military)
  const candidates = ["new_lead", "new_lead_military", "follow_up_2d", "birthday", "holiday", "payment_reminder", "sold_welcome"];
  for (const k of candidates) {
    if (typeof mt[k] === "string" && mt[k].trim()) out[k] = mt[k];
  }
  return out;
}

export default function MessageTestPage() {
  const { user } = useAuth();

  // Gate: only this email can access
  const allowed = (user?.email || "").toLowerCase() === "jacobprieto@gmail.com";

  const [loading, setLoading] = useState(true);
  const [mt, setMt] = useState(null);              // message_templates row
  const [agent, setAgent] = useState(null);        // agent_profiles row
  const [toNumber, setToNumber] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [sending, setSending] = useState(false);
  const [serverMsg, setServerMsg] = useState("");

  // Lead-ish context you can tweak
  const [ctx, setCtx] = useState({
    first_name: "",
    name: "",
    state: "TN",
    beneficiary: "your spouse",
    agent_name: "",
    agent_phone: "",
    calendly_link: "",
  });

  // Load data
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

        // Seed ctx from agent + a pretend lead name
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

  const templates = useMemo(() => extractTemplateMap(mt), [mt]);
  const templateKeys = useMemo(() => Object.keys(templates), [templates]);

  useEffect(() => {
    if (!selectedKey && templateKeys.length) setSelectedKey(templateKeys[0]);
  }, [templateKeys, selectedKey]);

  const rendered = useMemo(() => renderTemplate(templates[selectedKey] || "", ctx), [templates, selectedKey, ctx]);

  async function sendOne(key) {
    if (!key) return;
    const raw = toNumber.trim();
    const e164 = normalizeToE164_US_CA(raw);
    if (!e164) {
      alert("Enter a valid US/CA number (e.g. +16155551234).");
      return;
    }
    const text = renderTemplate(templates[key] || "", ctx).trim();
    if (!text) {
      alert("Template rendered empty. Adjust context.");
      return;
    }

    setSending(true);
    setServerMsg("");
    try {
      // Optional auth header (not required, but fine to include)
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      const res = await fetch(`${FN_BASE}/messages-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          to: e164,
          body: text,
          requesterId: user?.id || null,
          lead_id: null, // this is a manual test-send
        }),
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.error) {
        throw new Error(out?.telnyx_response?.errors?.[0]?.detail || out?.error || "Send failed");
      }
      setServerMsg(`✅ Sent via Telnyx (id: ${out.telnyx_id || "n/a"})`);
    } catch (e) {
      console.error(e);
      setServerMsg(`❌ ${e.message || e}`);
    } finally {
      setSending(false);
    }
  }

  async function sendAll() {
    for (const k of templateKeys) {
      // eslint-disable-next-line no-await-in-loop
      await sendOne(k);
    }
  }

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

          <div className="mt-3 text-sm font-medium">Template</div>
          {templateKeys.length === 0 ? (
            <div className="text-sm text-white/60">No templates found for your account.</div>
          ) : (
            <>
              <select
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
                value={selectedKey}
                onChange={(e)=>setSelectedKey(e.target.value)}
              >
                {templateKeys.map(k => <option key={k} value={k}>{k}</option>)}
              </select>

              <div className="flex gap-2">
                <button
                  onClick={()=>sendOne(selectedKey)}
                  disabled={sending || !toNumber.trim()}
                  className="rounded-xl border border-white/15 bg-white text-black px-3 py-2 text-sm disabled:opacity-50"
                >
                  Send this template
                </button>
                <button
                  onClick={sendAll}
                  disabled={sending || !toNumber.trim()}
                  className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                  title="Send every available template to the number above"
                >
                  Send ALL
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
            {rendered || "—"}
          </div>
          {selectedKey && (
            <div className="mt-3 text-xs text-white/50">
              Template key: <code className="text-white/70">{selectedKey}</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
