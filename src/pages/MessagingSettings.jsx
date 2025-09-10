// File: src/pages/MessagingSettings.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { CreditCard, Check, Loader2, MessageSquare, Info, RotateCcw } from "lucide-react";

/* ---------------- Template Catalog ---------------- */
const TEMPLATE_DEFS = [
  { key: "new_lead", label: "New Lead (instant)" },
  { key: "appointment", label: "Appointment Reminder" },
  { key: "sold", label: "Sold - Policy Info" },
  { key: "payment_reminder", label: "Payment Reminder" },
  { key: "birthday_text", label: "Birthday Text" },
  { key: "holiday_text", label: "Holiday Text" },
];

/* ---------------- Suggested defaults ---------------- */
const DEFAULTS = {
  new_lead:
    "Hi {{first_name}}, this is {{agent_name}}, a licensed life insurance broker in {{state}}. I just received the form you sent in to my office where you listed {{beneficiary}} as the beneficiary. If I’m unable to reach you or there’s a better time to get back to you, feel free to book an appointment with me here: {{calendly_link}} " +
    "You can text me anytime at {{agent_phone}} (this business text line doesn’t accept calls).",

  appointment:
    "Hi {{first_name}}, this is {{agent_name}}, a licensed life insurance broker. I’m just reminding you about our scheduled appointment at {{appt_time}}. Please reply YES to confirm or let me know if another time works better. You can also reschedule here: {{calendly_link}} " +
    "You can text me at {{agent_phone}} (this business text line doesn’t accept calls).",

  sold:
    "Hi {{first_name}}, this is {{agent_name}}. Congratulations on getting approved! 🎉 Here are the details of your new policy:\n" +
    "• Carrier: {{carrier}}\n" +
    "• Policy #: {{policy_number}}\n" +
    "• Premium: ${{premium}}/mo\n" +
    "If you have any questions or need assistance, feel free to reach out by text. " +
    "You can text me at {{agent_phone}} (this business text line doesn’t accept calls).",

  payment_reminder:
    "Hi {{first_name}}, this is {{agent_name}}. I’m reaching out to remind you that your policy payment is coming up soon. If your billing details have changed or you need assistance, please let me know so we can avoid any interruptions. " +
    "Text me at {{agent_phone}} (this business text line doesn’t accept calls).",

  birthday_text:
    "Hi {{first_name}}, this is {{agent_name}}. I just wanted to wish you a very Happy Birthday! 🥳 Wishing you a wonderful year ahead. If you need anything related to your coverage, I’m always here to help. " +
    "You can text me at {{agent_phone}} (this business text line doesn’t accept calls).",

  holiday_text:
    "Hi {{first_name}}, this is {{agent_name}}. I wanted to wish you and your family a happy holiday season. Thank you for trusting me as your agent — I’m always here if you need assistance. " +
    "Text me anytime at {{agent_phone}} (this business text line doesn’t accept calls).",
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

  // Drawer state
  const [cheatOpen, setCheatOpen] = useState(false);

  const balanceDollars = (balanceCents / 100).toFixed(2);

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

      // templates
      const { data: tmpl } = await supabase
        .from("message_templates")
        .select("templates")
        .eq("user_id", uid)
        .maybeSingle();

      if (!mounted) return;
      if (tmpl?.templates && typeof tmpl.templates === "object") {
        setTemplates((prev) => ({ ...DEFAULTS, ...tmpl.templates }));
      } else {
        try {
          await supabase
            .from("message_templates")
            .upsert({ user_id: uid, templates: DEFAULTS });
        } catch {}
        setTemplates({ ...DEFAULTS });
      }

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
      mounted = false;
    };
  }, [userId]);

  /* -------- Autosave templates -------- */
  async function saveTemplates(next) {
    if (!userId) return;
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("message_templates")
        .upsert({ user_id: userId, templates: next });
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

  // Reset a single template to its default and autosave
  function resetTemplate(key) {
    const def = DEFAULTS[key] ?? "";
    updateTemplate(key, def);
  }

  // Reset ALL templates to defaults and autosave (with confirm)
  function resetAllTemplates() {
    const confirmed = window.confirm(
      "Reset all templates to the default messages? This will overwrite your custom text."
    );
    if (!confirmed) return;
    const next = { ...DEFAULTS };
    setTemplates(next);
    saveTemplates(next);
  }

  /* -------- Stripe top-up -------- */
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

  // compute whether everything already matches defaults
  const allDefault = Object.keys(DEFAULTS).every(
    (k) => (templates[k] ?? "") === (DEFAULTS[k] ?? "")
  );

  return (
    <div className="space-y-6">
      {/* Header */}
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
            <div className="mt-1 text-xs text-white/50">Texts are billed per segment.</div>
          </div>

          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => addFunds(500)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$5</button>
              <button type="button" onClick={() => addFunds(1000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$10</button>
              <button type="button" onClick={() => addFunds(2000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$20</button>
              <button type="button" onClick={() => addFunds(5000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$50</button>
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

      {/* Templates editor */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Message Templates</h3>
            <p className="text-xs text-white/60 truncate">
              Customize what’s sent for each event. Variables like <code className="px-1 rounded bg-white/10">{'{{first_name}}'}</code> are replaced automatically.
            </p>
          </div>

          {/* RIGHT-SIDE ACTIONS */}
          <div className="ml-auto flex items-center gap-2">
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
            return (
              <div key={key} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-1 flex items-center">
                  <div className="text-xs text-white/70">{label}</div>
                  <button
                    type="button"
                    onClick={() => resetTemplate(key)}
                    disabled={!isDirty}
                    title="Reset to default"
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                </div>

                <textarea
                  value={templates[key] ?? ""}
                  onChange={(e) => updateTemplate(key, e.target.value)}
                  rows={5}
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
                  placeholder={DEFAULTS[key]}
                />
              </div>
            );
          })}
        </div>

        {/* Drawer inline */}
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
                onClick={() => setCheatOpen(false)}
                className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              >
                Close
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
              <VarRow token="appt_time" desc="Formatted appointment time" />
              <VarRow token="carrier" desc="Policy carrier (e.g., Americo)" />
              <VarRow token="policy_number" desc="Issued policy number" />
              <VarRow token="premium" desc="Monthly premium amount" />
              <VarRow token="today" desc="Today’s date" />
              <VarRow token="state" desc="Lead’s state (from form)" />
              <VarRow token="beneficiary" desc="Lead’s listed beneficiary" />
              <VarRow token="calendly_link" desc="Your Calendly booking link" />
            </div>

            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-1 text-xs font-semibold">Example</div>
              <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] leading-5">
{'"Hi {{first_name}}, your policy {{policy_number}} with {{carrier}} is active at ${{premium}}/mo. —{{agent_name}} (Text me at {{agent_phone}}, this line doesn’t accept calls)"'}
              </pre>
            </div>
          </aside>
        )}
      </section>

      {/* Compliance */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm font-medium">Compliance</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-white/70">
          <li>Only text clients who have opted in or have an existing relationship.</li>
          <li>Include any disclosures your brand requires.</li>
        </ul>
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
