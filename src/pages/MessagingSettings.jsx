// File: src/pages/MessagingSettings.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { CreditCard, Check, Loader2, MessageSquare, Info, RotateCcw, Lock, Phone, X } from "lucide-react";

/* ---------------- Template Catalog (appointment removed) ---------------- */
const TEMPLATE_DEFS = [
  { key: "new_lead", label: "New Lead (instant)" },
  { key: "new_lead_military", label: "New Lead (military)" },
  { key: "sold", label: "Sold - Policy Info" },
  { key: "payment_reminder", label: "Payment Reminder (coming soon)" },
  { key: "birthday_text", label: "Birthday Text (coming soon)" },
  { key: "holiday_text", label: "Holiday Text (coming soon)" },
];

// Templates locked until those flows are ready
const LOCKED_KEYS = new Set(["payment_reminder", "birthday_text", "holiday_text"]);

/* Default enabled map: ALL OFF by default */
const DEFAULT_ENABLED = Object.fromEntries(TEMPLATE_DEFS.map((t) => [t.key, false]));

/* ---------------- Carrier-safe defaults (with agent_site; appointment removed) ---------------- */
const DEFAULTS = {
  new_lead:
    "Hi {{first_name}}, it’s {{agent_name}} in {{state}}. I received your request listing {{beneficiary}} as beneficiary. When you’re ready, book here: {{agent_site}}",
  new_lead_military:
    "Hi {{first_name}}, it’s {{agent_name}} the veterans life specialist here in {{state}}. I got the form you sent in to me, let’s book an appointment to go over this: {{agent_site}}",
  sold:
    "Hi {{first_name}}, it’s {{agent_name}}. Your policy is active:\n• Carrier: {{carrier}}\n• Policy #: {{policy_number}}\n• Premium: ${{premium}}/mo\nQuestions? Text me at {{agent_phone}}.",
  payment_reminder:
    "Hi {{first_name}}, it’s {{agent_name}}. Friendly reminder: your policy payment is coming up. Need anything updated? Text me here.",
  birthday_text:
    "Hi {{first_name}}, it’s {{agent_name}}. Happy birthday! If you need anything with your coverage, text me here.",
  holiday_text:
    "Hi {{first_name}}, it’s {{agent_name}}. Wishing you a happy holiday season. I’m here if you need anything for your coverage.",
};

/* Small toggle */
function Toggle({ checked, onChange, label, disabled = false }) {
  const base = "inline-flex items-center rounded-full border px-2 py-1 text-[11px] select-none";
  const state = checked ? "bg-emerald-500/15 text-emerald-300 border-white/15" : "bg-white/5 text-white/70 border-white/15";
  const disabledCls = disabled ? "opacity-60 cursor-not-allowed" : "hover:bg-white/10";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[base, state, disabledCls].join(" ")}
      title={label}
    >
      <span className={["mr-2 inline-block h-3.5 w-6 rounded-full transition", checked ? "bg-emerald-400/30" : "bg-white/15"].join(" ")}>
        <span className={["block h-3 w-3 rounded-full bg-white shadow transition-transform", checked ? "translate-x-3" : "translate-x-0"].join(" ")} />
      </span>
      {checked ? "Enabled" : "Disabled"}
    </button>
  );
}

/* ---------- Template filler (for Test) ---------- */
function formatToday() {
  try {
    const d = new Date();
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "Today";
  }
}
function fillTemplate(text, data) {
  if (!text) return "";
  // Safety shim: replace any old Calendly token with agent_site
  let t = text.replace(/{{\s*calendly_link\s*}}/g, "{{agent_site}}");

  const map = {
    ...data,
    today: data?.today || formatToday(),
    full_name: data?.full_name || [data?.first_name, data?.last_name].filter(Boolean).join(" ").trim(),
  };
  return t.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const v = map[key];
    return v == null ? "" : String(v);
  });
}

/* Display helper for E.164 */
function prettyE164(e164) {
  const s = String(e164 || "");
  const m = s.match(/^\+1?(\d{10})$/);
  if (!m) return s || "";
  const d = m[1];
  return `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/* ------------------ TFN helpers (auto-assign flow) ------------------ */
/* NEW: send the Supabase JWT so Netlify functions can authenticate the request */
async function withAuthHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiGetTFNStatus() {
  const headers = await withAuthHeaders();
  const res = await fetch("/.netlify/functions/tfn-status", { headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP_${res.status}`);
  return j; // { ok, phone_number, verified }
}
async function apiAssignTFN() {
  const headers = await withAuthHeaders();
  const res = await fetch("/.netlify/functions/tfn-assign", { method: "POST", headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP_${res.status}`);
  return j; // { ok, phone_number, verified }
}

/* Default test values shown in the preview form */
const DEFAULT_TEST_DATA = {
  first_name: "Jacob",
  last_name: "Prieto",
  agent_name: "",
  company: "Prieto Insurance Solutions LLC",
  agent_phone: "",
  agent_email: "",
  agent_site: "",
  carrier: "Americo",
  policy_number: "A1B2C3D4",
  premium: "84.12",
  state: "TN",
  beneficiary: "Maria Prieto",
  military_branch: "US Army",
  today: "",
};

export default function MessagingSettings() {
  const [loading, setLoading] = useState(true);

  // Wallet
  const [balanceCents, setBalanceCents] = useState(0);
  const [topping, setTopping] = useState(false);

  // Auth
  const [userId, setUserId] = useState(null);

  // Custom amount state
  const [customUsd, setCustomUsd] = useState("");
  const [customMsg, setCustomMsg] = useState("");
  const MIN_CENTS = 100;
  const MAX_CENTS = 50000;

  // Templates
  const [templates, setTemplates] = useState(() => ({ ...DEFAULTS }));
  const [saveState, setSaveState] = useState("idle");
  const saveTimer = useRef(null);

  // Enabled map (per-template)
  const [enabledMap, setEnabledMap] = useState({ ...DEFAULT_ENABLED });
  const [enabledSaveState, setEnabledSaveState] = useState("idle");
  const enabledTimer = useRef(null);

  // Drawer state
  const [cheatOpen, setCheatOpen] = useState(false);

  // --- Test preview state ---
  const [testOpen, setTestOpen] = useState(false);
  const [testKey, setTestKey] = useState(null);
  const [testData, setTestData] = useState({ ...DEFAULT_TEST_DATA });

  // --- Agent vars from agent_profiles ---
  const [agentVars, setAgentVars] = useState({
    agent_name: "",
    agent_email: "",
    agent_phone: "",
    agent_site: "",
  });

  // --- Messaging Number state (same backend flow, UI hides digits) ---
  const [myTFN, setMyTFN] = useState(null);
  const [tfnVerified, setTfnVerified] = useState(false);
  const [tfnLoading, setTfnLoading] = useState(true);
  const [tfnAssigning, setTfnAssigning] = useState(false);
  const [tfnError, setTfnError] = useState("");

  const balanceDollars = (balanceCents / 100).toFixed(2);

  /* -------- Global ESC to close drawers -------- */
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        if (cheatOpen) setCheatOpen(false);
        if (testOpen) setTestOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cheatOpen, testOpen]);

  /* -------- Load data -------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);

      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }
      if (!mounted) return;
      setUserId(uid);

      // wallet
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);

      // templates + enabled flags
      const { data: tmpl } = await supabase
        .from("message_templates")
        .select("templates, enabled")
        .eq("user_id", uid)
        .maybeSingle();

      if (!mounted) return;

      if (tmpl?.templates && typeof tmpl.templates === "object") {
        setTemplates((prev) => ({ ...DEFAULTS, ...tmpl.templates, __enabled: undefined }));
      } else {
        try {
          await supabase.from("message_templates").upsert({ user_id: uid, templates: DEFAULTS });
        } catch {}
        setTemplates({ ...DEFAULTS });
      }

      let initialEnabled = { ...DEFAULT_ENABLED };
      const maybeEnabledFromCol = tmpl?.enabled && typeof tmpl.enabled === "object" ? tmpl.enabled : null;
      const maybeEnabledFromTemplates =
        tmpl?.templates?.__enabled && typeof tmpl.templates.__enabled === "object"
          ? tmpl.templates.__enabled
          : null;

      if (maybeEnabledFromCol) {
        initialEnabled = { ...DEFAULT_ENABLED, ...maybeEnabledFromCol };
      } else if (maybeEnabledFromTemplates) {
        initialEnabled = { ...DEFAULT_ENABLED, ...maybeEnabledFromTemplates };
      }

      // Force UI-locked templates off
      for (const k of LOCKED_KEYS) initialEnabled[k] = false;
      setEnabledMap(initialEnabled);

      if (!maybeEnabledFromCol && !maybeEnabledFromTemplates) {
        try {
          await supabase.from("message_templates").upsert({ user_id: uid, enabled: initialEnabled });
        } catch {
          try {
            const merged = { ...DEFAULTS, __enabled: initialEnabled };
            await supabase.from("message_templates").upsert({ user_id: uid, templates: merged });
          } catch {}
        }
      }

      // agent profile (include slug to build agent_site)
      const { data: profile } = await supabase
        .from("agent_profiles")
        .select("full_name, email, phone, slug")
        .eq("user_id", uid)
        .maybeSingle();

      if (!mounted) return;

      const slug = (profile?.slug || "").trim();
      const agent_site = slug ? `https://remiecrm.com/a/${slug}` : "";

      const nextAgentVars = {
        agent_name: profile?.full_name || "",
        agent_email: profile?.email || "",
        agent_phone: profile?.phone || "",
        agent_site,
      };
      setAgentVars(nextAgentVars);

      setTestData((d) => ({
        ...d,
        agent_name: d.agent_name || nextAgentVars.agent_name,
        agent_email: d.agent_email || nextAgentVars.agent_email,
        agent_phone: d.agent_phone || nextAgentVars.agent_phone,
        agent_site: d.agent_site || nextAgentVars.agent_site,
      }));

      setLoading(false);
    })();

    const ch = supabase
      .channel("wallet_rt")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_wallets" },
        (payload) => {
          if (payload.new?.user_id === userId) {
            setBalanceCents(payload.new.balance_cents || 0);
          }
        }
      )
      .subscribe();

    return () => {
      try {
        supabase.removeChannel?.(ch);
      } catch {}
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (enabledTimer.current) clearTimeout(enabledTimer.current);
    };
  }, [userId]);

  /* -------- Load messaging number status -------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      setTfnError("");
      setTfnLoading(true);
      try {
        const s = await apiGetTFNStatus();
        if (!mounted) return;
        setMyTFN(s?.phone_number || null);
        setTfnVerified(!!s?.verified);
      } catch (e) {
        if (!mounted) return;
        setTfnError(e.message || "Failed to load messaging number.");
      } finally {
        if (mounted) setTfnLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  /* -------- Autosave templates -------- */
  async function saveTemplates(next) {
    if (!userId) return;
    setSaveState("saving");
    try {
      const { error } = await supabase.from("message_templates").upsert({ user_id: userId, templates: next });
      if (error) throw error;
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    } catch (e) {
      console.error(e);
      setSaveState("error");
    }
  }

  function updateTemplate(key, val) {
    const next = { ...templates, [key]: val };
    setTemplates(next);
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveTemplates(next), 800);
  }

  function resetTemplate(key) {
    const def = DEFAULTS[key] ?? "";
    updateTemplate(key, def);
  }

  function resetAllTemplates() {
    const confirmed = window.confirm("Reset all templates to the default messages? This will overwrite your custom text.");
    if (!confirmed) return;
    const next = { ...DEFAULTS };
    setTemplates(next);
    saveTemplates(next);
  }

  /* -------- Save enabled flags -------- */
  async function persistEnabled(nextMap) {
    if (!userId) return;
    setEnabledSaveState("saving");
    const fixed = { ...nextMap };
    for (const k of LOCKED_KEYS) fixed[k] = false;
    setEnabledMap(fixed);
    try {
      const { error } = await supabase.from("message_templates").upsert({ user_id: userId, enabled: fixed });
      if (error) throw error;
      setEnabledSaveState("saved");
      setTimeout(() => setEnabledSaveState("idle"), 1200);
      return;
    } catch (e) {
      console.warn("No 'enabled' column available, embedding into templates.__enabled", e?.message);
    }
    try {
      const nextTemplates = { ...templates, __enabled: fixed };
      setTemplates(nextTemplates);
      const { error } = await supabase.from("message_templates").upsert({ user_id: userId, templates: nextTemplates });
      if (error) throw error;
      setEnabledSaveState("saved");
      setTimeout(() => setEnabledSaveState("idle"), 1200);
    } catch (e2) {
      console.error(e2);
      setEnabledSaveState("error");
    }
  }

  function setEnabled(key, val) {
    if (LOCKED_KEYS.has(key)) {
      const next = { ...enabledMap, [key]: false };
      setEnabledMap(next);
      setEnabledSaveState("saving");
      if (enabledTimer.current) clearTimeout(enabledTimer.current);
      enabledTimer.current = setTimeout(() => persistEnabled(next), 500);
      return;
    }
    const next = { ...enabledMap, [key]: !!val };
    setEnabledMap(next);
    setEnabledSaveState("saving");
    if (enabledTimer.current) clearTimeout(enabledTimer.current);
    enabledTimer.current = setTimeout(() => persistEnabled(next), 500);
  }

  /* -------- Stripe top-up -------- */
  async function startStripeTopUp({ userId, netTopUpCents, clientRef, coverFees = true, returnTo }) {
    const res = await fetch("/.netlify/functions/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletTopUp: true,
        userId,
        netTopUpCents,
        clientRef,
        coverFees,
        successUrl: returnTo || window.location.origin + "/app/wallet?success=1",
        cancelUrl: returnTo || window.location.origin + "/app/wallet?canceled=1",
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Stripe session failed: ${txt}`);
    }
    const data = await res.json();
    if (!data?.url) throw new Error("Missing Stripe Checkout URL");
    window.location.href = data.url;
  }

  async function topUpStripe(amountCents) {
    if (!userId) return alert("Please sign in first.");
    try {
      setTopping(true);
      await startStripeTopUp({
        userId,
        netTopUpCents: amountCents,
        clientRef: `${userId}:${Date.now()}`,
        coverFees: true,
        returnTo: window.location.origin,
      });
    } catch (e) {
      console.error(e);
      alert(e.message || "Could not start checkout.");
    } finally {
      setTopping(false);
    }
  }

  function addCustom() {
    setCustomMsg("");
    const n = Number(customUsd);
    if (!Number.isFinite(n)) {
      setCustomMsg("Enter a valid dollar amount.");
      return;
    }
    const cents = Math.round(n * 100);
    if (cents < MIN_CENTS || cents > MAX_CENTS) {
      setCustomMsg("Amount must be between $1 and $500.");
      return;
    }
    topUpStripe(cents);
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        <div className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading messaging settings…
        </div>
      </div>
    );
  }

  const allDefault = Object.keys(DEFAULTS).every((k) => (templates[k] ?? "") === (DEFAULTS[k] ?? ""));
  const activePreviewKey = testKey;
  const activePreviewTemplate = activePreviewKey ? templates[activePreviewKey] ?? "" : "";
  const activePreviewFilled = activePreviewKey ? fillTemplate(activePreviewTemplate, { ...agentVars, ...testData }) : "";

  // Missing slug guard for UX (only inform, page still usable)
  const missingAgentSite = !agentVars.agent_site;

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h1 className="text-lg font-semibold">Messaging Settings</h1>
        <p className="mt-1 text-sm text-white/70">Manage your text balance, messaging number, and message templates.</p>
      </header>

      {/* Wallet block */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm text-white/60">Text balance</div>
            <div className="text-xl font-semibold">${balanceDollars}</div>
            <div className="mt-1 text-xs text-white/50">Texts are billed per segment.</div>
          </div>

          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => topUpStripe(500)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$5</button>
              <button type="button" onClick={() => topUpStripe(1000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$10</button>
              <button type="button" onClick={() => topUpStripe(2000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$20</button>
              <button type="button" onClick={() => topUpStripe(5000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$50</button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-white/60">Custom:</label>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1.5 text-sm text-white/50">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="1"
                    max="500"
                    step="1"
                    value={customUsd}
                    onChange={(e) => setCustomUsd(e.target.value)}
                    placeholder="e.g. 7"
                    className="w-24 rounded-lg border border-white/15 bg-white/5 pl-5 pr-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
                  />
                </div>
                <button type="button" onClick={addCustom} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> Add</button>
              </div>
              {customMsg && <div className="text-xs text-amber-300">{customMsg}</div>}
            </div>

            <div className="text-[11px] text-white/40">Allowed custom range: $1–$500</div>
          </div>
        </div>
      </section>

      {/* Messaging Number (auto-assign from verified pool) */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
              <Phone className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Messaging Number</h3>
              <p className="text-xs text-white/60">
                We’ll assign a verified messaging number for your outbound texts.
              </p>
            </div>
          </div>

          {myTFN ? (
            <div className="text-[11px] text-white/50">Number locked. Contact support to change.</div>
          ) : null}
        </div>

        {/* Status / Actions */}
        {tfnLoading ? (
          <div className="rounded-lg bg-white/5 p-3 text-sm text-white/70">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Checking status…
          </div>
        ) : tfnError ? (
          <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">{tfnError}</div>
        ) : !myTFN ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg bg-white/5 p-3 text-sm text-white/70">
              You don’t have a messaging number yet. Click the button below and we’ll assign one from our verified pool.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    setTfnError("");
                    setTfnAssigning(true);
                    const r = await apiAssignTFN();
                    setMyTFN(r?.phone_number || null);
                    setTfnVerified(!!r?.verified);
                  } catch (e) {
                    setTfnError(e.message || "Failed to assign number.");
                  } finally {
                    setTfnAssigning(false);
                  }
                }}
                disabled={tfnAssigning}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-60"
              >
                {tfnAssigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                <span>{tfnAssigning ? "Assigning…" : "Get Messaging Number"}</span>
              </button>
              <a href="/support" className="text-xs text-white/60 hover:text-white">
                Need help? Contact Support
              </a>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm">
            <div className="text-white/80">
              <span className="font-semibold">Messaging number is set.</span>
            </div>
            <span
              className={`rounded-md px-2 py-0.5 text-[11px] ${
                tfnVerified
                  ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                  : "border border-amber-300/30 bg-amber-300/10 text-amber-200"
              }`}
            >
              {tfnVerified ? "Verified & ready" : "Pending verification"}
            </span>
          </div>
        )}
      </section>

      {/* Templates editor */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Message Templates</h3>
            <p className="mt-1 text-xs text-white/60 truncate">
              Customize what’s sent for each event. Variables like <code className="px-1 rounded bg-white/10">{"{{first_name}}"}</code> are replaced automatically.
            </p>
            {missingAgentSite && (
              <div className="mt-2 text-[11px] text-amber-300">
                Heads up: your Agent Site link is not set yet. Add a <code className="px-1 rounded bg-white/10">slug</code> in your profile to enable <code className="px-1 rounded bg-white/10">{"{{agent_site}}"}</code>.
              </div>
            )}
          </div>

          {/* RIGHT-SIDE ACTIONS */}
          <div className="ml-auto flex items-center gap-2">
            {enabledSaveState === "saving" && (
              <span className="inline-flex items-center gap-1 text-xs text-white/70">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating toggles…
              </span>
            )}
            {enabledSaveState === "saved" && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Check className="h-3 w-3" /> Toggles saved
              </span>
            )}
            {enabledSaveState === "error" && (
              <span className="text-xs text-rose-300">Toggle save failed</span>
            )}

            <button
              type="button"
              onClick={resetAllTemplates}
              disabled={allDefault}
              className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-40"
              title="Reset all templates to default"
            >
              <RotateCcw className="h-4 w-4" />
              Reset All
            </button>
            <button
              type="button"
              onClick={() => setCheatOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
              title="Show template variables"
            >
              <Info className="h-4 w-4" />
              Template Variables
            </button>
          </div>

          <div className="text-xs text-white/60">
            {saveState === "saving" && (
              <span className="ml-3 inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
            {saveState === "saved" && (
              <span className="ml-3 inline-flex items-center gap-1 text-emerald-300">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
            {saveState === "error" && <span className="ml-3 text-rose-300">Save failed</span>}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {TEMPLATE_DEFS.map(({ key, label }) => {
            const isDirty = (templates[key] ?? "") !== (DEFAULTS[key] ?? "");
            const enabled = !!enabledMap[key];
            const isLocked = LOCKED_KEYS.has(key);

            return (
              <div key={key} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-xs text-white/70">{label}</div>

                  <div className="ml-2">
                    <Toggle
                      checked={enabled}
                      onChange={(v) => setEnabled(key, v)}
                      disabled={isLocked}
                      label={enabled ? "Disable this template" : "Enable this template"}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => resetTemplate(key)}
                    disabled={!isDirty}
                    title="Reset to default"
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setTestKey(key);
                      setTestOpen(true);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                    title="Preview with sample data"
                  >
                    Test
                  </button>
                </div>

                {isLocked && (
                  <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200">
                    <Lock className="h-3.5 w-3.5" />
                    This template is <b className="ml-1">coming soon</b>. It's disabled until scheduling is ready.
                  </div>
                )}

                <textarea
                  value={templates[key] ?? ""}
                  onChange={(e) => updateTemplate(key, e.target.value)}
                  rows={5}
                  className={[
                    "w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1",
                    "border-white/15 bg-white/5 focus:ring-indigo-400/50",
                    enabled ? "" : "opacity-70",
                  ].join(" ")}
                  placeholder={DEFAULTS[key]}
                />

                {!enabled && !isLocked && (
                  <div className="mt-2 text-[11px] text-amber-300/90">
                    Disabled — this template will not send until you enable it.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Backdrop for drawers */}
        {(cheatOpen || testOpen) && (
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => {
              if (testOpen) setTestOpen(false);
              else if (cheatOpen) setCheatOpen(false);
            }}
          />
        )}

        {/* Template Variables Drawer */}
        {cheatOpen && (
          <aside
            className="fixed right-0 top-0 z-50 h-full w-full max-w-md transform rounded-l-2xl border-l border-white/10 bg-[#0b0b12] p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Template Variables"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="inline-flex items-center gap-2">
                <Info className="h-5 w-5" />
                <h2 className="text-sm font-semibold">Template Variables</h2>
              </div>
              <button
                type="button"
                className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
                onClick={() => setCheatOpen(false)}
                aria-label="Close template variables"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-xs text-white/70">
              Paste these tokens into any template. The system replaces them automatically when messages are sent.
            </p>

            <div className="space-y-3 text-xs">
              <VarRow token="first_name" desc="Lead’s first name" />
              <VarRow token="last_name" desc="Lead’s last name" />
              <VarRow token="full_name" desc="Lead’s full name" />
              <VarRow token="agent_name" desc="Your display name" />
              <VarRow token="company" desc="Your agency/company" />
              <VarRow token="agent_phone" desc="Your phone number" />
              <VarRow token="agent_email" desc="Your email address" />
              <VarRow token="agent_site" desc="Your Agent Site link (from profile slug)" />
              <VarRow token="carrier" desc="Policy carrier (e.g., Americo)" />
              <VarRow token="policy_number" desc="Issued policy number" />
              <VarRow token="premium" desc="Monthly premium amount" />
              <VarRow token="today" desc="Today’s date" />
              <VarRow token="state" desc="Lead’s state (from form)" />
              <VarRow token="beneficiary" desc="Lead’s listed beneficiary" />
              <VarRow token="military_branch" desc="Military branch (if provided)" />
            </div>
          </aside>
        )}

        {/* Test Preview Panel */}
        {testOpen && (
          <aside
            className="fixed bottom-0 left-0 right-0 z-50 mx-auto w-full max-w-5xl rounded-t-2xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Template Test Preview"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="inline-flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                <h2 className="text-sm font-semibold">
                  Test Preview — {TEMPLATE_DEFS.find(t => t.key === activePreviewKey)?.label || activePreviewKey}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setTestOpen(false)}
                className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
                aria-label="Close test preview"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Test data form */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-2 text-xs font-semibold">Test Data</div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.keys(DEFAULT_TEST_DATA).map((k) => (
                    <label key={k} className="text-[11px] text-white/70">
                      <div className="mb-1">
                        {k}
                        {["agent_name","agent_email","agent_phone","agent_site"].includes(k) && (
                          <span className="ml-1 rounded bg-white/10 px-1 py-[1px] text-[10px] text-white/60">from profile</span>
                        )}
                      </div>
                      <input
                        value={(k in testData ? testData[k] : "")}
                        onChange={(e) => setTestData((d) => ({ ...d, [k]: e.target.value }))}
                        className="w-full rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
                        placeholder={String(DEFAULT_TEST_DATA[k] ?? "")}
                      />
                    </label>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                    onClick={() => setTestData((d) => ({
                      ...DEFAULT_TEST_DATA,
                      agent_name: agentVars.agent_name || DEFAULT_TEST_DATA.agent_name,
                      agent_email: agentVars.agent_email || DEFAULT_TEST_DATA.agent_email,
                      agent_phone: agentVars.agent_phone || DEFAULT_TEST_DATA.agent_phone,
                      agent_site: agentVars.agent_site || DEFAULT_TEST_DATA.agent_site,
                    }))}
                  >
                    Reset Test Data
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                    onClick={() => setTestData((d) => ({ ...d }))}
                  >
                    Refresh Preview
                  </button>
                </div>
              </div>

              {/* Filled preview */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-2 text-xs font-semibold">Rendered Message</div>
                <pre className="min-h-[180px] whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 text-[12px] leading-5">
                  {activePreviewFilled}
                </pre>
                <div className="mt-2 text-[11px] text-white/50">
                  Tokens like {"{{first_name}}"} are replaced using your Agent Profile (for agent_* fields) and the Test Data on the left.
                </div>
              </div>
            </div>
          </aside>
        )}
      </section>
    </div>
  );
}

/* --- Var row --- */
function VarRow({ token, desc }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-2">
      <code className="rounded bg-white/10 px-1.5 py-0.5 text-[11px]">{`{{${token}}}`}</code>
      <div className="flex-1 text-right text-white/70">{desc}</div>
    </div>
  );
}

/* --- Helper for your sender --- */
export function pickNewLeadTemplateKey(lead) {
  const branch = (lead?.military_branch || "").trim();
  return branch ? "new_lead_military" : "new_lead";
}
