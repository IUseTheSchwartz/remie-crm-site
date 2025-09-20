// File: src/pages/LeadRescuePage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  Loader2, Check, RotateCcw, Pause, Play, SkipForward, Trash2, Plus, Info
} from "lucide-react";
import { toE164 } from "../lib/phone";

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

// Same quick token filler used in MessagingSettings preview
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

// ---- Page ----
export default function LeadRescuePage() {
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);

  // Settings
  const [enabled, setEnabled] = useState(false);
  const [sendTz, setSendTz] = useState(TZ_DEFAULT);
  const [sendHourLocal, setSendHourLocal] = useState(9);
  const [maxDays, setMaxDays] = useState(5);
  const [repeatAfterDays, setRepeatAfterDays] = useState(null);
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
        setMaxDays(Number.isFinite(s.max_days) ? s.max_days : 5);
        setRepeatAfterDays(
          s.repeat_after_days === null || s.repeat_after_days === undefined
            ? null
            : s.repeat_after_days
        );
      } else {
        // create default row once
        try {
          await supabase.from("lead_rescue_settings").insert({
            user_id: uid,
            enabled: false,
            send_tz: TZ_DEFAULT,
            send_hour_local: 9,
            max_days: 5,
            repeat_after_days: null,
          });
        } catch {}
      }

      // Templates
      const { data: trows } = await supabase
        .from("lead_rescue_templates")
        .select("day_number, body")
        .eq("user_id", uid)
        .order("day_number", { ascending: true });

      setTemplates(
        (trows || []).filter((t) => (t.day_number || 0) >= 2)
      );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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
        max_days: Math.max(2, Number(maxDays) || 5),
        repeat_after_days:
          repeatAfterDays === "" || repeatAfterDays === null
            ? null
            : Math.max(0, Number(repeatAfterDays)),
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
      // blank body = store empty string (treated as skip)
      const { error } = await supabase
        .from("lead_rescue_templates")
        .upsert({ user_id: userId, day_number: day, body: body || "" }, { onConflict: "user_id,day_number" });
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

  function nextDayNumber() {
    const max = Math.max(2, ...templates.map((t) => t.day_number));
    return max + 1;
    }

  async function addDay() {
    const d = nextDayNumber();
    upsertLocalTemplate(d, "");
    await persistTemplate(d, "");
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
    // Just bumps the counter (the cron will send at the next window)
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
          Daily follow-ups for contacts in your lead/military funnel. Messages only go out if the contact still exists and hasn’t replied.
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

        <div className="grid gap-3 md:grid-cols-4">
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

          <label className="text-sm">
            <div className="mb-1 text-white/70">Time Zone</div>
            <input
              value={sendTz}
              onChange={(e) => setSendTz(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              placeholder="America/Chicago"
            />
          </label>

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

          <label className="text-sm">
            <div className="mb-1 text-white/70">Max days</div>
            <input
              type="number"
              min={2}
              value={maxDays}
              onChange={(e) => setMaxDays(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              placeholder="5"
            />
          </label>

          <label className="text-sm md:col-span-2">
            <div className="mb-1 text-white/70">Repeat after days (optional; 0 = loop; blank = no repeat)</div>
            <input
              type="number"
              min={0}
              value={repeatAfterDays === null ? "" : repeatAfterDays}
              onChange={(e) =>
                setRepeatAfterDays(e.target.value === "" ? null : Number(e.target.value))
              }
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              placeholder=""
            />
          </label>
        </div>

        <div className="mt-3">
          <button
            onClick={saveSettings}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
          >
            {savingSettings === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save settings
          </button>
          {savingSettings === "saved" && (
            <span className="ml-2 text-xs text-emerald-300">Saved</span>
          )}
          {savingSettings === "error" && (
            <span className="ml-2 text-xs text-rose-300">Save failed</span>
          )}
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
          </div>
        </div>

        {templates.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/70">
            No Day 2+ templates yet. Click “Add day” to create Day 2.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {templates.map((t) => (
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
                <Th>Day</Th>
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
                      <Td>Day {r.current_day}</Td>
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
