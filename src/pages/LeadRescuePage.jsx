// File: src/pages/LeadRescuePage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  Loader2, Check, RotateCcw, Pause, Play, SkipForward, Trash2, Plus, Info, RefreshCcw
} from "lucide-react";

// ---- Helpers ----
const TZ_DEFAULT = "America/Chicago";
function classNames(...xs) { return xs.filter(Boolean).join(" "); }

function formatPhoneLocalMask(p) {
  if (!p) return "";
  const d = String(p).replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("1")) {
    return `1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7, 11)}`;
  }
  if (d.length >= 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  }
  return p;
}

function VarBadge({ token }) {
  return (
    <code className="rounded bg-white/10 px-1.5 py-0.5 text-[11px]">{`{{${token}}}`}</code>
  );
}

// Same quick token filler used in MessagingSettings preview (kept for future)
function fillTemplate(text, data) {
  if (!text) return "";
  const map = {
    ...data,
    full_name:
      data?.full_name ||
      [data?.first_name, data?.last_name].filter(Boolean).join(" ").trim(),
  };
  return String(text).replace(/{{\s*([\w.]+)\s*}}/g, (_, k) =>
    map[k] == null ? "" : String(map[k])
  );
}

// Status renderer: Day 1 is not part of Rescue -> show "Waiting for Day 2 @ ..." until first Rescue send
function renderRescueStatus(currentDay, sendHourLocal, tz) {
  const cd = Number(currentDay || 1);
  if (cd <= 1) {
    const hh = String(Number(sendHourLocal ?? 9)).padStart(2, "0");
    return `Waiting for Day 2 @ ${hh}:00 ${tz || TZ_DEFAULT}`;
  }
  return `Day ${cd}`;
}

/* ---------- Preset library (Day 2 → Day 31) ----------
   Uses your placeholders {{first_name}}, {{agent_name}}, {{state}}, {{beneficiary}},
   {{calendly_link}}, {{agent_phone}}. Edit copy as you like. */
const PRESETS = {
  2:  "Hi {{first_name}}, it’s {{agent_name}} in {{state}}. You listed {{beneficiary}} on your form. I can help you pick the right coverage. Book a quick call: {{calendly_link}} — or text me here at {{agent_phone}}.",
  3:  "Hi {{first_name}}, just checking in. I reviewed your request with {{beneficiary}} listed. When’s best today or tomorrow? You can also grab a time: {{calendly_link}}.",
  4:  "{{first_name}}, quick heads up: rates are based on age/health and can change. Let’s lock yours in. 5–10 min is fine. Scheduler: {{calendly_link}}.",
  5:  "Hi {{first_name}}, this is {{agent_name}} (licensed in {{state}}). I help families set up tax-free benefits for loved ones like {{beneficiary}}. Want me to text you options or hop on a quick call? {{calendly_link}}",
  6:  "Follow-up for {{beneficiary}}’s protection: I can show 2–3 simple plans that fit your budget. Reply “Options” and I’ll text them, or book: {{calendly_link}}.",
  7:  "Weekly check-in: Did you still want that coverage for {{beneficiary}}? I can tailor something around your budget. Quick call: {{calendly_link}}.",
  8:  "Hey {{first_name}}, I prepared quotes already—just need 5 minutes to confirm details. Want me to text them or call? {{calendly_link}}",
  9:  "Reminder: your info shows eligibility now. We can lock in pricing before the next birthday/age band. Book here: {{calendly_link}}.",
  10: "I can compare top carriers and show you the best 2. Free and no pressure. Save your spot: {{calendly_link}}.",
  11: "Hi {{first_name}}, do mornings or afternoons work better? I’ll keep it under 10 minutes. {{calendly_link}}",
  12: "Most families choose a plan that covers final expenses and leaves a little for {{beneficiary}}. Want that breakdown? {{calendly_link}}",
  13: "Quick nudge: completing this now avoids re-quoting later. Reply “Ready” and I’ll call, or use: {{calendly_link}}.",
  14: "2-week follow-up: still want coverage for {{beneficiary}}? I can finalize this today. {{calendly_link}}",
  15: "I’ll tailor options to your budget (no medical exam needed in most cases). Call/text or book: {{calendly_link}}.",
  16: "Hi {{first_name}}, want me to run a lower-payment option that still protects {{beneficiary}}? Reply “Lower” or book: {{calendly_link}}.",
  17: "We can start with a small starter plan and increase later. Interested? {{calendly_link}}",
  18: "Fast path: Valid ID + a few questions. Coverage can start same day. Want to try? {{calendly_link}}.",
  19: "I can also email the quotes if easier. What’s best—text, call, or email? {{calendly_link}}",
  20: "Your form mentioned {{beneficiary}}. Let’s make sure they’re protected. 5 minutes: {{calendly_link}}.",
  21: "3-week check-in: any changes to your budget or timing? I’ll adjust the plan. {{calendly_link}}.",
  22: "Many pick a plan that covers funeral costs + a cushion. Want those two options? {{calendly_link}}.",
  23: "Carrier promos change; I’ll make sure you get the best one you qualify for. Quick chat? {{calendly_link}}.",
  24: "If you prefer weekends/evenings, I can open a slot. When works? Or grab one: {{calendly_link}}.",
  25: "Would you like a text with ‘Good/Better/Best’ options? Reply “G/B/B” or book: {{calendly_link}}.",
  26: "We can protect {{beneficiary}} even on a tight budget. I’ll fit the plan to you. {{calendly_link}}.",
  27: "Almost done: a few yes/no questions and we’re set. Want to wrap this up? {{calendly_link}}.",
  28: "Month check-in: still planning to set this up? I can finalize today or send updated quotes. {{calendly_link}}.",
  29: "If calling isn’t your thing, I’ll text the two best fits right here. Want me to? {{calendly_link}}.",
  30: "Final follow-up for now: I’m here when you’re ready, {{first_name}}. Save this: {{calendly_link}} — {{agent_phone}}.",
  31: "Re-touch: Life changes fast—if now’s a better time, I’ll make it easy. Book here: {{calendly_link}}.",
};

// ---- Page ----
export default function LeadRescuePage() {
  // 🔒 Temporary off switch. Set to false to re-enable the full page.
  const UNDER_MAINTENANCE = true;
  if (UNDER_MAINTENANCE) {
    return (
      <div className="flex h-full min-h-[60vh] w-full items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Sorry — Under Maintenance</h1>
          <p className="mt-2 text-white/70">
            The Lead Rescue page is temporarily unavailable while we make updates.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10"
            >
              Go Back
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl border border-white/15 bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
            >
              Refresh
            </button>
          </div>
          <p className="mt-3 text-xs text-white/50">Thanks for your patience—check back soon.</p>
        </div>
      </div>
    );
  }

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);

  // Settings
  const [enabled, setEnabled] = useState(false);
  const [sendTz, setSendTz] = useState(TZ_DEFAULT);
  const [sendHourLocal, setSendHourLocal] = useState(9);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [savingSettings, setSavingSettings] = useState("idle");

  // Templates (Day 2+)
  const [templates, setTemplates] = useState([]); // array of { day_number, body }
  const [savingTpl, setSavingTpl] = useState("idle");
  const saveTplTimer = useRef(null);

  // Trackers list (contacts in sequence)
  const [trackers, setTrackers] = useState([]); // merged with contact info
  const [filter, setFilter] = useState("");
  const [loadingTrackers, setLoadingTrackers] = useState(false);

  // UI state
  const [varsOpen, setVarsOpen] = useState(false);

  // ---- Initial load ----
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: session } = await supabase.auth.getSession();
      const uid = session?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }
      setUserId(uid);

      // Settings
      const { data: s } = await supabase
        .from("lead_rescue_settings")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();

      if (s) {
        setEnabled(!!s.enabled);
        setSendTz(s.send_tz || TZ_DEFAULT);
        setSendHourLocal(Number.isFinite(s.send_hour_local) ? s.send_hour_local : 9);
        setLoopEnabled(s.loop_enabled !== undefined ? !!s.loop_enabled : true);
      } else {
        // create default row once
        try {
          await supabase.from("lead_rescue_settings").insert({
            user_id: uid,
            enabled: false,
            send_tz: TZ_DEFAULT,
            send_hour_local: 9,
            loop_enabled: true,
          });
        } catch {}
      }

      // Templates
      const { data: trows } = await supabase
        .from("lead_rescue_templates")
        .select("day_number, body")
        .eq("user_id", uid)
        .order("day_number", { ascending: true });

      setTemplates((trows || []).filter((t) => (t.day_number || 0) >= 2));

      setLoading(false);
    })();
  }, []);

  // ---- Load trackers (with contact info) ----
  async function refreshTrackers() {
    if (!userId) return;
    setLoadingTrackers(true);
    try {
      const { data: trs } = await supabase
        .from("lead_rescue_trackers")
        .select("contact_id, current_day, last_attempt_at, responded, paused, stop_reason, started_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      const ids = Array.from(new Set((trs || []).map((r) => r.contact_id))).filter(Boolean);
      let contacts = [];
      if (ids.length) {
        const { data: cts } = await supabase
          .from("message_contacts")
          .select("id, full_name, phone, tags")
          .in("id", ids);
        contacts = cts || [];
      }
      const map = new Map(contacts.map((c) => [c.id, c]));
      const merged = (trs || []).map((r) => ({
        ...r,
        contact: map.get(r.contact_id) || null,
      }));
      setTrackers(merged);
    } catch (e) {
      console.error("Could not load trackers:", e);
    } finally {
      setLoadingTrackers(false);
    }
  }

  useEffect(() => {
    refreshTrackers();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Settings save ----
  async function saveSettings() {
    if (!userId) return;
    setSavingSettings("saving");
    try {
      const payload = {
        user_id: userId,
        enabled: !!enabled,
        send_tz: sendTz || TZ_DEFAULT,
        send_hour_local: Number(sendHourLocal) || 9,
        loop_enabled: !!loopEnabled,
      };
      const { error } = await supabase
        .from("lead_rescue_settings")
        .upsert(payload, { onConflict: "user_id" });
      if (error) throw error;
      setSavingSettings("saved");
      setTimeout(() => setSavingSettings("idle"), 1000);
    } catch (e) {
      console.error(e);
      setSavingSettings("error");
    }
  }

  // ---- Template helpers ----
  function upsertLocalTemplate(day, body) {
    setTemplates((list) => {
      const idx = list.findIndex((t) => t.day_number === day);
      if (idx === -1) return [...list, { day_number: day, body }];
      const next = [...list];
      next[idx] = { day_number: day, body };
      return next;
    });
  }

  async function persistTemplate(day, body) {
    if (!userId) return;
    setSavingTpl("saving");
    try {
      const { error } = await supabase
        .from("lead_rescue_templates")
        .upsert(
          { user_id: userId, day_number: day, body: body || "" },
          { onConflict: "user_id,day_number" }
        );
      if (error) throw error;
      setSavingTpl("saved");
      setTimeout(() => setSavingTpl("idle"), 800);
    } catch (e) {
      console.error(e);
      setSavingTpl("error");
    }
  }

  function changeTemplate(day, body) {
    upsertLocalTemplate(day, body);
    if (saveTplTimer.current) clearTimeout(saveTplTimer.current);
    saveTplTimer.current = setTimeout(() => persistTemplate(day, body), 600);
  }

  // ✅ first added day is Day 2, then Day 3, etc.
  function nextDayNumber() {
    if (!templates || templates.length === 0) return 2; // first one is Day 2
    const max = Math.max(...templates.map((t) => t.day_number || 0));
    return Math.max(2, max) + 1;
  }

  // ⬇️ changed: add day with PRESET instead of blank
  async function addDay() {
    const d = nextDayNumber();
    const preset = PRESETS[d] || `Follow-up for Day ${d}.`;
    upsertLocalTemplate(d, preset);
    await persistTemplate(d, preset);
  }

  // ⬇️ new: add 30-day plan (fills missing 2→31 with presets)
  async function addThirtyPlan() {
    if (!userId) return;
    const existing = new Set(templates.map(t => t.day_number));
    const toAdd = [];
    for (let d = 2; d <= 31; d++) {
      if (!existing.has(d)) {
        toAdd.push({ day_number: d, body: PRESETS[d] || `Follow-up for Day ${d}.` });
      }
    }
    if (!toAdd.length) return;

    // Update UI immediately
    setTemplates(prev => [...prev, ...toAdd].sort((a,b)=>a.day_number-b.day_number));

    // Persist in one batch
    try {
      setSavingTpl("saving");
      const payload = toAdd.map(r => ({ user_id: userId, day_number: r.day_number, body: r.body }));
      const { error } = await supabase.from("lead_rescue_templates").insert(payload);
      if (error) throw error;
      setSavingTpl("saved");
      setTimeout(() => setSavingTpl("idle"), 800);
    } catch (e) {
      console.error(e);
      setSavingTpl("error");
    }
  }

  async function removeDay(day) {
    if (!confirm(`Remove Day ${day}? (No messages will be sent for this day until you add it back.)`)) return;
    setTemplates((list) => list.filter((t) => t.day_number !== day));
    try {
      await supabase
        .from("lead_rescue_templates")
        .delete()
        .eq("user_id", userId)
        .eq("day_number", day);
    } catch (e) {
      console.error(e);
    }
  }

  // ---- Tracker actions ----
  async function pauseTracker(contactId) {
    await supabase
      .from("lead_rescue_trackers")
      .update({ paused: true, stop_reason: "manual" })
      .eq("user_id", userId)
      .eq("contact_id", contactId);
    refreshTrackers();
  }
  async function resumeTracker(contactId) {
    await supabase
      .from("lead_rescue_trackers")
      .update({ paused: false, stop_reason: null })
      .eq("user_id", userId)
      .eq("contact_id", contactId);
    refreshTrackers();
  }
  async function advanceOneDay(contactId) {
    const { data: cur } = await supabase
      .from("lead_rescue_trackers")
      .select("current_day")
      .eq("user_id", userId)
      .eq("contact_id", contactId)
      .maybeSingle();
    const cd = cur?.current_day || 1;
    await supabase
      .from("lead_rescue_trackers")
      .update({ current_day: cd + 1 })
      .eq("user_id", userId)
      .eq("contact_id", contactId);
    refreshTrackers();
  }
  async function resetToDay1(contactId) {
    await supabase
      .from("lead_rescue_trackers")
      .update({ current_day: 1, responded: false, paused: false, stop_reason: null })
      .eq("user_id", userId)
      .eq("contact_id", contactId);
    refreshTrackers();
  }

  const visibleTrackers = useMemo(() => {
    const q = (filter || "").toLowerCase();
    const src = trackers.map((t) => ({
      ...t,
      name: t?.contact?.full_name || "",
      phone: t?.contact?.phone || "",
      tags: t?.contact?.tags || [],
    }));
    if (!q) return src;
    return src.filter((r) =>
      [r.name, r.phone, ...(r.tags || [])].some((v) => String(v || "").toLowerCase().includes(q))
    );
  }, [trackers, filter]);

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        <div className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading Lead Rescue…
        </div>
      </div>
    );
  }

  // ---- UI ----
  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h1 className="text-lg font-semibold">Lead Rescue</h1>
        <p className="mt-1 text-sm text-white/70">
          Daily follow-ups for contacts in your lead/military funnel. First send is the next calendar day at your Send Hour. If Loop is on, it continues every day using your last non-empty template until the contact replies.
        </p>
      </header>

      {/* Settings */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="text-sm font-semibold">Settings</div>
          <button
            onClick={() => setVarsOpen((s) => !s)}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
            title="Template variables"
          >
            <Info className="h-3.5 w-3.5" /> Variables
          </button>
        </div>

        {varsOpen && (
          <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
            <div className="mb-2 font-medium">Available variables</div>
            <div className="flex flex-wrap gap-2">
              <VarBadge token="first_name" />
              <VarBadge token="last_name" />
              <VarBadge token="full_name" />
              <VarBadge token="agent_name" />
              <VarBadge token="company" />
              <VarBadge token="agent_phone" />
              <VarBadge token="agent_email" />
              <VarBadge token="state" />
              <VarBadge token="beneficiary" />
              <VarBadge token="military_branch" />
              <VarBadge token="calendly_link" />
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-5">
          {/* Enabled */}
          <label className="text-sm">
            <div className="mb-1 text-white/70">Enabled</div>
            <button
              type="button"
              onClick={() => setEnabled((v) => !v)}
              className={classNames(
                "inline-flex items-center rounded-full border px-3 py-1 text-xs",
                enabled ? "bg-emerald-500/15 text-emerald-300 border-white/15" : "bg-white/5 text-white/70 border-white/15"
              )}
            >
              {enabled ? "On" : "Off"}
            </button>
          </label>

          {/* Loop */}
          <label className="text-sm">
            <div className="mb-1 text-white/70">Loop (daily after last day)</div>
            <button
              type="button"
              onClick={() => setLoopEnabled((v) => !v)}
              className={classNames(
                "inline-flex items-center rounded-full border px-3 py-1 text-xs",
                loopEnabled ? "bg-indigo-500/20 text-indigo-200 border-white/15" : "bg-white/5 text-white/70 border-white/15"
              )}
            >
              {loopEnabled ? "On" : "Off"}
            </button>
          </label>

          {/* Time Zone */}
          <label className="text-sm">
            <div className="mb-1 text-white/70">Time Zone</div>
            <input
              value={sendTz}
              onChange={(e) => setSendTz(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              placeholder="America/Chicago"
            />
          </label>

          {/* Send Hour */}
          <label className="text-sm">
            <div className="mb-1 text-white/70">Send hour (local)</div>
            <input
              type="number"
              min={0}
              max={23}
              value={sendHourLocal}
              onChange={(e) => setSendHourLocal(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              placeholder="9"
            />
          </label>

          {/* Save */}
          <div className="flex items-end">
            <button
              onClick={saveSettings}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
            >
              {savingSettings === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save settings
            </button>
            {savingSettings === "saved" && (
              <span className="ml-2 text-xs text-emerald-300 self-center">Saved</span>
            )}
            {savingSettings === "error" && (
              <span className="ml-2 text-xs text-rose-300 self-center">Save failed</span>
            )}
          </div>
        </div>
      </section>

      {/* Templates editor (Day 2+) */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">Day Templates (Day 2+)</div>
          <div className="flex items-center gap-2">
            {savingTpl === "saving" && (
              <span className="inline-flex items-center gap-1 text-xs text-white/70">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
            {savingTpl === "saved" && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
            {savingTpl === "error" && (
              <span className="text-xs text-rose-300">Save failed</span>
            )}
            <button
              onClick={addDay}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
            >
              <Plus className="h-3.5 w-3.5" /> Add day
            </button>
            <button
              onClick={addThirtyPlan}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              title="Fill missing days up to Day 31 with presets"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> Add 30-day plan
            </button>
          </div>
        </div>

        <p className="mb-3 text-xs text-white/60">
          Day 1 is your initial message. Day 2+ send at your Send Hour. If <b>Loop</b> is ON, days beyond your highest defined day will reuse the <b>last non-empty template</b> daily until the contact replies.
        </p>

        {templates.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/70">
            No Day 2+ templates yet. Click “Add day” to create Day 2, or “Add 30-day plan” to fill 2→31 with presets.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {templates
            .slice()
            .sort((a,b)=>a.day_number - b.day_number)
            .map((t) => (
            <div key={t.day_number} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs text-white/70">Day {t.day_number}</div>
                <button
                  onClick={() => removeDay(t.day_number)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                  title={`Remove Day ${t.day_number}`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
              <textarea
                value={t.body || ""}
                onChange={(e) => changeTemplate(t.day_number, e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
                placeholder="(blank = skip this day)"
              />
              {/* Preset hint if blank */}
              {(!t.body?.trim() && PRESETS[t.day_number]) ? (
                <div className="mt-2 text-[11px] text-white/50">
                  Preset suggestion: <span className="italic">{PRESETS[t.day_number]}</span>
                </div>
              ) : null}
              <div className="mt-2 text-[11px] text-white/50">
                Use variables like {" "}<VarBadge token="first_name" />{" "}<VarBadge token="agent_name" />{" "}
                <VarBadge token="calendly_link" /> etc.
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Trackers / participants */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="text-sm font-semibold">Active Contacts</div>
          <div className="ml-auto">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search name / phone / tag…"
              className="w-64 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
            />
          </div>
          <button
            onClick={refreshTrackers}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
            title="Refresh"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-[900px] w-full border-collapse text-sm">
            <thead className="bg-white/[0.04] text-white/70">
              <tr>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Status</Th>
                <Th>Responded</Th>
                <Th>Paused</Th>
                <Th>Last Attempt</Th>
                <Th>Reason</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loadingTrackers ? (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-white/60">
                    <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                    Loading…
                  </td>
                </tr>
              ) : visibleTrackers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-white/60">No contacts currently in Lead Rescue.</td>
                </tr>
              ) : (
                visibleTrackers.map((r) => {
                  const name = r?.contact?.full_name || "—";
                  const phone = r?.contact?.phone ? formatPhoneLocalMask(r.contact.phone) : "—";
                  const last = r.last_attempt_at ? new Date(r.last_attempt_at).toLocaleString() : "—";
                  return (
                    <tr key={`${r.contact_id}`} className="border-t border-white/10">
                      <Td>{name}</Td>
                      <Td>{phone}</Td>
                      <Td>{renderRescueStatus(r.current_day, sendHourLocal, sendTz)}</Td>
                      <Td>{r.responded ? "Yes" : "No"}</Td>
                      <Td>{r.paused ? "Yes" : "No"}</Td>
                      <Td>{last}</Td>
                      <Td>{r.stop_reason || "—"}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          {r.paused ? (
                            <button
                              onClick={() => resumeTracker(r.contact_id)}
                              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                              title="Resume"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => pauseTracker(r.contact_id)}
                              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                              title="Pause"
                            >
                              <Pause className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => advanceOneDay(r.contact_id)}
                            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                            title="Advance 1 day"
                          >
                            <SkipForward className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => resetToDay1(r.contact_id)}
                            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                            title="Reset to Day 1"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-2">{children}</td>; }
