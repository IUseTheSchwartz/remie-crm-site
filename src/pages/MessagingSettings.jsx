// File: src/pages/MessagingSettings.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { CreditCard, Check, Loader2, MessageSquare } from "lucide-react";

/* ---------------- Template Catalog (keys + friendly names) ---------------- */
const TEMPLATE_DEFS = [
  { key: "new_lead", label: "New Lead (instant)" },
  { key: "appointment", label: "Appointment Reminder" },
  { key: "sold", label: "Sold - Congrats" },
  { key: "policy_info", label: "Sold - Policy Info" },
  { key: "payment_reminder", label: "Payment Reminder" },
  { key: "birthday_text", label: "Birthday Text" },
  { key: "holiday_text", label: "Holiday Text" },
];

/* ---------------- Suggested default messages ----------------
  You can use variables:
    {{first_name}}, {{last_name}}, {{full_name}}, {{agent_name}},
    {{company}}, {{agent_phone}}, {{agent_email}},
    {{appt_time}}, {{policy_number}}, {{carrier}}, {{premium}},
    {{today}}, {{opt_out}}
---------------------------------------------------------------- */
const DEFAULTS = {
  new_lead:
    "Hi {{first_name}}! This is {{agent_name}} with {{company}}. I just received your request—when is a good time today to chat for 2–3 minutes? {{opt_out}}",
  appointment:
    "Hi {{first_name}}, reminder for our call at {{appt_time}} with {{agent_name}} ({{company}}). Reply YES to confirm or 2 to reschedule. {{opt_out}}",
  sold:
    "Congrats {{first_name}}! 🎉 We’re approved. I’ll send your policy details next. If you have questions, text me anytime. {{opt_out}}",
  policy_info:
    "Policy info for {{first_name}}:\n• Carrier: {{carrier}}\n• Policy #: {{policy_number}}\n• Premium: ${{premium}}/mo\nSave this for your records. {{opt_out}}",
  payment_reminder:
    "Hi {{first_name}}, a friendly reminder your payment is coming up. If anything changed with your card or bank, text me here. {{opt_out}}",
  birthday_text:
    "Happy Birthday, {{first_name}}! 🥳 Wishing you a great year ahead. —{{agent_name}} {{opt_out}}",
  holiday_text:
    "Happy holidays from {{agent_name}} at {{company}}! Hope you and your family are well. {{opt_out}}",
};

export default function MessagingSettings() {
  const [loading, setLoading] = useState(true);

  // Wallet
  const [balanceCents, setBalanceCents] = useState(0);
  const [topping, setTopping] = useState(false);

  // Auth
  const [userId, setUserId] = useState(null);

  // Custom amount state
  const [customUsd, setCustomUsd] = useState(""); // string input
  const [customMsg, setCustomMsg] = useState(""); // validation/output message
  const MIN_CENTS = 100;   // $1
  const MAX_CENTS = 50000; // $500

  // Templates
  const [templates, setTemplates] = useState(() => ({ ...DEFAULTS }));
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const saveTimer = useRef(null);

  const balanceDollars = (balanceCents / 100).toFixed(2);

  // Load session, wallet, templates
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);

      // who am i?
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }
      if (!mounted) return;
      setUserId(uid);

      // load wallet
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);

      // load templates row (single JSON blob keyed by user)
      const { data: tmpl } = await supabase
        .from("message_templates")
        .select("templates")
        .eq("user_id", uid)
        .maybeSingle();

      if (!mounted) return;
      if (tmpl?.templates && typeof tmpl.templates === "object") {
        // merge: keep any newly added defaults not in DB yet
        setTemplates((prev) => ({ ...DEFAULTS, ...tmpl.templates }));
      } else {
        // not present -> seed defaults (lazy)
        try {
          await supabase
            .from("message_templates")
            .upsert({ user_id: uid, templates: DEFAULTS });
        } catch {}
        setTemplates({ ...DEFAULTS });
      }

      setLoading(false);
    })();

    // realtime updates to wallet
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
      mounted = false;
    };
  }, [userId]);

  /* ---------------- Save templates (debounced autosave) ---------------- */
  async function saveTemplates(next) {
    if (!userId) return;
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("message_templates")
        .upsert({ user_id: userId, templates: next });
      if (error) throw error;
      setSaveState("saved");
      // clear state back to idle after a moment
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

  /* ---------------- Stripe top-ups ---------------- */
  async function addFunds(amountCents) {
    setCustomMsg("");
    setTopping(true);
    try {
      const res = await fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_cents: amountCents,
          reason: "wallet_topup",
          user_id: userId,
        }),
      });

      if (!res.ok) {
        // show server-provided error when possible
        let msg = "Could not start checkout.";
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }

      const { url } = await res.json();
      if (!url) throw new Error("No checkout URL returned");
      window.location.href = url;
    } catch (e) {
      console.error(e);
      alert(e.message || "Could not start checkout.");
    } finally {
      setTopping(false);
    }
  }

  // custom amount flow
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
    addFunds(cents);
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

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h1 className="text-lg font-semibold">Messaging Settings</h1>
        <p className="mt-1 text-sm text-white/70">
          Manage your text balance and message templates. (Twilio connection can be finished later.)
        </p>
      </header>

      {/* Wallet block */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm text-white/60">Text balance</div>
            <div className="text-xl font-semibold">${balanceDollars}</div>
            <div className="mt-1 text-xs text-white/50">
              Texts are billed per segment. “Reply STOP to opt out.” is appended when needed.
            </div>
          </div>

          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => addFunds(500)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                title="Add $5"
              >
                <CreditCard className="h-4 w-4" /> +$5
              </button>
              <button
                onClick={() => addFunds(1000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                title="Add $10"
              >
                <CreditCard className="h-4 w-4" /> +$10
              </button>
              <button
                onClick={() => addFunds(2000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                title="Add $20"
              >
                <CreditCard className="h-4 w-4" /> +$20
              </button>
              <button
                onClick={() => addFunds(5000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                title="Add $50"
              >
                <CreditCard className="h-4 w-4" /> +$50
              </button>
            </div>

            {/* Custom amount input */}
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
                <button
                  onClick={addCustom}
                  disabled={topping}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
                  title="Add custom amount"
                >
                  <CreditCard className="h-4 w-4" /> Add
                </button>
              </div>
              {customMsg && <div className="text-xs text-amber-300">{customMsg}</div>}
            </div>

            <div className="text-[11px] text-white/40">Allowed custom range: $1–$500</div>
          </div>
        </div>
      </section>

      {/* Templates editor (per-user; Twilio can be wired up later) */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Message Templates</h3>
            <p className="text-xs text-white/60">
              Customize what’s sent for each event. Variables like <code className="px-1 rounded bg-white/10">{{"{{first_name}}"}}</code> are
              replaced automatically.
            </p>
          </div>
          <div className="ml-auto text-xs text-white/60">
            {saveState === "saving" && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span>}
            {saveState === "saved" && <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="h-3 w-3" /> Saved</span>}
            {saveState === "error" && <span className="text-rose-300">Save failed</span>}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {TEMPLATE_DEFS.map(({ key, label }) => (
            <div key={key} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="text-xs mb-1 text-white/70">{label}</div>
              <textarea
                value={templates[key] ?? ""}
                onChange={(e) => updateTemplate(key, e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
                placeholder={DEFAULTS[key]}
              />
              <div className="mt-2 text-[11px] text-white/50">
                Tip: Include <code className="px-1 rounded bg-white/10">{{"{{opt_out}}"}}</code> to append “Reply STOP to opt out.”
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Compliance */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm font-medium">Compliance</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-white/70">
          <li>Only text clients who have opted in or have an existing relationship.</li>
          <li>Include required disclosures (e.g., “Msg&data rates may apply. Reply STOP to opt out.”).</li>
          <li>STOP/START/HELP are honored automatically by carriers when enabled with your provider.</li>
        </ul>
      </section>
    </div>
  );
}
