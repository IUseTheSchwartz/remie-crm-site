// File: src/pages/ReelsCreator.jsx
import { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Copy, Check, Link as LinkIcon, Plus, Trash2, PlayCircle, Settings2 } from "lucide-react";

/** ---- Built-in template catalog (MVP) ----
 * Add your CapCut URLs (mobile/desktop can be the same URL).
 * Each template defines its input fields and a render function that turns inputs into a script.
 */
const BUILT_IN_TEMPLATES = [
  {
    id: "what-i-made-in-a-day",
    name: "What I Made in a Day",
    tagline: "Commission reveal + quick hook",
    capcut: {
      mobileUrl: "",   // Paste a CapCut template link here (optional)
      desktopUrl: "",  // Paste a CapCut template link here (optional)
      notes: "Use a bold money counter overlay + cash register SFX.",
    },
    fields: [
      { key: "day_of_week", label: "Day of week", type: "text", placeholder: "Monday" },
      { key: "policies", label: "Policies closed", type: "number", placeholder: "3" },
      { key: "earnings", label: "Earnings ($)", type: "number", placeholder: "1200" },
      { key: "product", label: "Product focus", type: "text", placeholder: "Final Expense / Mortgage Protection" },
      { key: "cta", label: "CTA", type: "text", placeholder: "Book in my bio" },
    ],
    render: (v) =>
      `Hook: “It’s ${v.day_of_week || "today"} and I just made $${v.earnings || "0"} helping families.”
Beat 1: Closed ${v.policies || "0"} policy(ies) for ${v.product || "life insurance"}.
Beat 2: Quick breakdown: leads → calls → appointments → closes.
Beat 3: Reminder: commissions are from real clients we protect.
CTA: ${v.cta || "Tap the link in my bio to book a call."}`,
  },
  {
    id: "pov-work-in-sales",
    name: "POV: You Work in Sales",
    tagline: "Objection → turn-around → win",
    capcut: {
      mobileUrl: "",
      desktopUrl: "",
      notes: "Use caption pop-ups for the objection → rebuttal → win.",
    },
    fields: [
      { key: "product", label: "Product", type: "text", placeholder: "Life Insurance" },
      { key: "objection", label: "Top objection", type: "text", placeholder: "Let me think about it" },
      { key: "rebuttal", label: "Your rebuttal", type: "text", placeholder: "Totally — quick question…" },
      { key: "win", label: "Win moment", type: "text", placeholder: "They booked the appointment" },
      { key: "cta", label: "CTA", type: "text", placeholder: "DM me 'INFO' for details" },
    ],
    render: (v) =>
      `POV: You sell ${v.product || "life insurance"}.
Client: “${v.objection || "I need to think about it"}”
You: “${v.rebuttal || "Totally — quick question to make sure it fits…"}”
Result: ${v.win || "They got protected today."}
CTA: ${v.cta || "DM 'INFO' and I’ll send the steps."}`,
  },
  {
    id: "pov-sell-insurance",
    name: "POV: You Sell Insurance",
    tagline: "Protecting real families",
    capcut: {
      mobileUrl: "",
      desktopUrl: "",
      notes: "Use warm B-roll (door knock, Zoom call, handshake).",
    },
    fields: [
      { key: "state", label: "State", type: "text", placeholder: "Tennessee" },
      { key: "client_type", label: "Client type", type: "text", placeholder: "young family / senior" },
      { key: "beneficiary", label: "Beneficiary", type: "text", placeholder: "their daughter" },
      { key: "feeling", label: "Feeling/tone", type: "text", placeholder: "relieved / grateful" },
      { key: "cta", label: "CTA", type: "text", placeholder: "Schedule in bio" },
    ],
    render: (v) =>
      `POV: Agent in ${v.state || "your state"} helping a ${v.client_type || "family"}.
We just set up coverage so ${v.beneficiary || "their loved one"} is protected.
They looked ${v.feeling || "relieved"}.
If you want the same peace of mind: ${v.cta || "book a 10-min call in my bio."}`,
  },
  {
    id: "week-in-sales",
    name: "Week in Sales (Recap)",
    tagline: "Weekly scoreboard + lessons",
    capcut: {
      mobileUrl: "",
      desktopUrl: "",
      notes: "Use a 3-panel scoreboard; overlay key lessons.",
    },
    fields: [
      { key: "appointments", label: "Appointments set", type: "number", placeholder: "12" },
      { key: "sits", label: "Sits", type: "number", placeholder: "8" },
      { key: "closes", label: "Closes", type: "number", placeholder: "5" },
      { key: "premium", label: "Total premium ($)", type: "number", placeholder: "4200" },
      { key: "lesson", label: "Top lesson", type: "text", placeholder: "Call back faster; book same-day" },
      { key: "cta", label: "CTA", type: "text", placeholder: "Comment 'PLAYBOOK' for my script" },
    ],
    render: (v) =>
      `Weekly Recap:
Appointments: ${v.appointments || 0} | Sits: ${v.sits || 0} | Closes: ${v.closes || 0} | Premium: $${v.premium || 0}
Lesson: ${v.lesson || "Volume wins; speed matters."}
CTA: ${v.cta || "Comment 'PLAYBOOK' and I’ll send my script."}`,
  },
];

function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}

function Field({ def, value, onChange }) {
  const common =
    "w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 outline-none focus:ring-2 focus:ring-fuchsia-400/40";
  if (def.type === "number") {
    return (
      <input
        type="number"
        inputMode="decimal"
        className={common}
        placeholder={def.placeholder || ""}
        value={value ?? ""}
        onChange={(e) => onChange(def.key, e.target.value)}
      />
    );
  }
  return (
    <input
      type="text"
      className={common}
      placeholder={def.placeholder || ""}
      value={value ?? ""}
      onChange={(e) => onChange(def.key, e.target.value)}
    />
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text || "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {}
      }}
      className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3 py-2 hover:bg-white/20 transition"
      title="Copy script"
    >
      {copied ? <Check size={18} /> : <Copy size={18} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function ReelsCreator() {
  const [templates, setTemplates] = useLocalStorage("reels_creator.custom_templates", []);
  const catalog = useMemo(() => [...BUILT_IN_TEMPLATES, ...templates], [templates]);

  const [selectedId, setSelectedId] = useState(catalog[0]?.id || "");
  useEffect(() => {
    // Keep selection valid when user adds/removes templates
    if (!catalog.find((t) => t.id === selectedId)) {
      setSelectedId(catalog[0]?.id || "");
    }
  }, [catalog, selectedId]);

  const active = catalog.find((t) => t.id === selectedId);
  const [values, setValues] = useState({});
  useEffect(() => setValues({}), [selectedId]); // reset inputs when switching template
  const script = active?.render?.(values) || "";

  function setVal(key, v) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  // Custom template builder (simple)
  const [newTpl, setNewTpl] = useState({
    name: "",
    tagline: "",
    mobileUrl: "",
    desktopUrl: "",
    notes: "",
    fieldsText: "title:text\namount:number\ncta:text",
    scriptText:
      "Hook: {{title}}\nI made ${{amount}} today helping families.\nCTA: {{cta}}",
  });

  function addCustomTemplate() {
    if (!newTpl.name?.trim()) return;
    const id = newTpl.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const fields = newTpl.fieldsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // "key:type[:Label][:Placeholder]" (Label/Placeholder optional)
        const parts = line.split(":");
        const key = parts[0];
        const type = parts[1] === "number" ? "number" : "text";
        const label = parts[2] || key.replace(/_/g, " ");
        const placeholder = parts[3] || "";
        return { key, type, label, placeholder };
      });

    const render = (v) =>
      newTpl.scriptText.replace(/\{\{(\w+)\}\}/g, (_, k) => (v[k] ?? ""));

    const custom = {
      id: `${id}-${Date.now()}`,
      name: newTpl.name,
      tagline: newTpl.tagline,
      capcut: {
        mobileUrl: newTpl.mobileUrl,
        desktopUrl: newTpl.desktopUrl || newTpl.mobileUrl,
        notes: newTpl.notes,
      },
      fields,
      render,
      isCustom: true,
    };
    setTemplates((prev) => [...prev, custom]);
    setNewTpl({
      name: "",
      tagline: "",
      mobileUrl: "",
      desktopUrl: "",
      notes: "",
      fieldsText: "title:text\namount:number\ncta:text",
      scriptText:
        "Hook: {{title}}\nI made ${{amount}} today helping families.\nCTA: {{cta}}",
    });
  }

  function removeTemplate(tid) {
    setTemplates((prev) => prev.filter((t) => t.id !== tid));
  }

  return (
    <div className="p-4 sm:p-6 md:p-8">
      {/* Title */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Reels Creator</h1>
          <p className="text-white/70">Generate a punchy script and jump into your CapCut template.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Template picker + CapCut links */}
        <motion.div
          layout
          className="lg:col-span-1 rounded-2xl border border-white/10 bg-white/5 p-4"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Templates</h2>
            <div className="text-xs text-white/60">Built-in + Custom</div>
          </div>

          <div className="space-y-2 max-h-[22rem] overflow-auto pr-1">
            {catalog.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left rounded-xl border px-3 py-3 transition ${
                  selectedId === t.id
                    ? "border-fuchsia-400/50 bg-fuchsia-400/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-white/60">{t.tagline}</div>
                  </div>
                  {t.isCustom && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTemplate(t.id);
                      }}
                      className="ml-3 rounded-lg border border-white/10 bg-white/5 p-2 hover:bg-white/10"
                      title="Delete custom template"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* CapCut links + notes */}
          {active && (
            <div className="mt-4 space-y-3">
              <div className="text-sm font-semibold">CapCut Template</div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={active.capcut?.mobileUrl || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
                    active.capcut?.mobileUrl
                      ? "border-white/10 bg-white/10 hover:bg-white/20"
                      : "border-white/10 bg-white/5 opacity-50 cursor-not-allowed"
                  }`}
                  title={active.capcut?.mobileUrl ? "Open in CapCut (Mobile)" : "Add a CapCut link in this template"}
                >
                  <PlayCircle size={18} />
                  Open (Mobile)
                </a>

                <a
                  href={active.capcut?.desktopUrl || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
                    active.capcut?.desktopUrl
                      ? "border-white/10 bg-white/10 hover:bg-white/20"
                      : "border-white/10 bg-white/5 opacity-50 cursor-not-allowed"
                  }`}
                  title={active.capcut?.desktopUrl ? "Open in CapCut (Desktop)" : "Add a CapCut link in this template"}
                >
                  <LinkIcon size={18} />
                  Open (Desktop)
                </a>
              </div>
              {active.capcut?.notes && (
                <p className="text-xs text-white/60 leading-relaxed">{active.capcut.notes}</p>
              )}
            </div>
          )}
        </motion.div>

        {/* Middle: Dynamic inputs */}
        <motion.div
          layout
          className="lg:col-span-1 rounded-2xl border border-white/10 bg-white/5 p-4"
        >
          <h2 className="font-semibold mb-3">Customize</h2>
          {!active ? (
            <div className="text-white/60 text-sm">Select a template.</div>
          ) : active.fields?.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {active.fields.map((f) => (
                <div key={f.key} className="space-y-1">
                  <div className="text-xs text-white/70">{f.label}</div>
                  <Field def={f} value={values[f.key]} onChange={setVal} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-white/60 text-sm">No fields required.</div>
          )}
        </motion.div>

        {/* Right: Script preview */}
        <motion.div
          layout
          className="lg:col-span-1 rounded-2xl border border-white/10 bg-white/5 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Script Preview</h2>
            <CopyButton text={script} />
          </div>
          <pre className="whitespace-pre-wrap text-sm leading-6 bg-black/20 rounded-xl p-3 border border-white/10 min-h-[14rem]">
            {script || "Your script will appear here…"}
          </pre>
          <div className="mt-3 text-xs text-white/60">
            Tip: Record A-roll reading this script. Then open the CapCut template to drop your clips and auto-apply captions/overlays.
          </div>
        </motion.div>
      </div>

      {/* Custom template builder */}
      <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Settings2 size={18} />
          <h2 className="font-semibold">Create Your Own Template</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-xs text-white/70">Template name</label>
            <input
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              value={newTpl.name}
              onChange={(e) => setNewTpl((p) => ({ ...p, name: e.target.value }))}
              placeholder="Income Flex, Fast POV, etc."
            />

            <label className="text-xs text-white/70">Tagline (short)</label>
            <input
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              value={newTpl.tagline}
              onChange={(e) => setNewTpl((p) => ({ ...p, tagline: e.target.value }))}
              placeholder="Quick hook + cash counter"
            />

            <label className="text-xs text-white/70">CapCut link (mobile)</label>
            <input
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              value={newTpl.mobileUrl}
              onChange={(e) => setNewTpl((p) => ({ ...p, mobileUrl: e.target.value }))}
              placeholder="https://www.capcut.com/template/…"
            />

            <label className="text-xs text-white/70">CapCut link (desktop, optional)</label>
            <input
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              value={newTpl.desktopUrl}
              onChange={(e) => setNewTpl((p) => ({ ...p, desktopUrl: e.target.value }))}
              placeholder="https://www.capcut.com/template/…"
            />

            <label className="text-xs text-white/70">Editor notes (optional)</label>
            <textarea
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              rows={4}
              value={newTpl.notes}
              onChange={(e) => setNewTpl((p) => ({ ...p, notes: e.target.value }))}
              placeholder="What overlays/captions to use, transitions, sfx…"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-white/70">Fields (one per line)</label>
            <textarea
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs"
              rows={10}
              value={newTpl.fieldsText}
              onChange={(e) => setNewTpl((p) => ({ ...p, fieldsText: e.target.value }))}
              placeholder={`key:type[:Label][:Placeholder]
day_of_week:text:Day of week:Monday
earnings:number:Earnings ($):1200`}
            />
            <div className="text-[11px] text-white/60">
              Format: <span className="font-mono">key:type[:Label][:Placeholder]</span> — type is{" "}
              <span className="font-mono">text</span> or <span className="font-mono">number</span>.
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-white/70">Script template</label>
            <textarea
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs"
              rows={12}
              value={newTpl.scriptText}
              onChange={(e) => setNewTpl((p) => ({ ...p, scriptText: e.target.value }))}
              placeholder={`Hook: {{title}}
I made ${{amount}} today helping families.
CTA: {{cta}}`}
            />
            <div className="text-[11px] text-white/60">
              Use <span className="font-mono">{{`{{field}}`}}</span> to insert field values.
            </div>
          </div>
        </div>

        <div className="mt-4">
          <button
            onClick={addCustomTemplate}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-4 py-2 hover:bg-white/20 transition"
          >
            <Plus size={18} />
            Add Template
          </button>
        </div>
      </div>
    </div>
  );
}
