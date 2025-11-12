// File: src/components/AutoDialerModal.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { toE164 } from "../../lib/phone.js";
import { startLeadFirstCall } from "../../lib/calls";

const STAGE_IDS = ["no_pickup","answered","quoted","app_started","app_pending","app_submitted"];
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
const PhoneMono = ({ children }) => <span className="font-mono whitespace-nowrap">{children}</span>;
const cap = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());

function parseStateFilter(s) {
  return String(s || "")
    .split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
}

/* ---------- UI helpers ---------- */
function maskForList(e164) {
  const s = String(e164 || "");
  const m = s.match(/^\+1?(\d{10})$/);
  if (!m) return s || "";
  const d = m[1];
  return `+1 (${d.slice(0,3)}) ***-${d.slice(6)}`;
}
function prettyE164(e164) {
  const s = String(e164 || "");
  const m = s.match(/^\+1?(\d{10})$/);
  if (!m) return s || "";
  const d = m[1];
  return `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

export default function AutoDialerModal({ onClose, rows = [] }) {
  // Filters & dialing config
  const [stateFilter, setStateFilter] = useState("");
  const [stageFilters, setStageFilters] = useState(new Set());
  const [maxAttempts, setMaxAttempts] = useState(1);

  // Queue + status
  const [queue, setQueue] = useState([]); // [{id, attempts, status}]
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);

  // Prevent double-advance per lead
  const settledRef = useRef(new Set()); // Set<leadId>

  // Timer control (for Pause)
  const pendingTimersRef = useRef([]);
  function addTimer(id) { pendingTimersRef.current.push(id); }
  function clearAllTimers() {
    for (const id of pendingTimersRef.current) clearTimeout(id);
    pendingTimersRef.current = [];
  }

  // Live call status by contact_id
  const [liveStatus, setLiveStatus] = useState({});
  const liveStatusRef = useRef({});
  useEffect(() => { liveStatusRef.current = liveStatus; }, [liveStatus]);

  // NEW: run id + map contact_id -> attempt_id (optional)
  const [runId, setRunId] = useState(null);
  const attemptByContactRef = useRef(new Map()); // contact_id -> attempt_id

  // Numbers
  const [agentPhone, setAgentPhone] = useState("");
  const [agentNums, setAgentNums] = useState([]);       // [{id, telnyx_number}]
  const [selectedFrom, setSelectedFrom] = useState(""); // default = use connection default
  const [loadMsg, setLoadMsg] = useState("");
  const [saveAgentMsg, setSaveAgentMsg] = useState("");

  // Load agent phone and agent_numbers
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadMsg("Loading your numbers…");
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (!uid) return;

        // agent phone
        const { data: profile } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", uid)
          .maybeSingle();

        let num = profile?.phone || "";
        const eNum = toE164(num);
        if (eNum && eNum !== num) {
          try { await supabase.from("agent_profiles").update({ phone: eNum }).eq("user_id", uid); } catch {}
          num = eNum;
        }
        if (mounted) setAgentPhone(num || "");

        // agent_numbers list
        const { data: nums } = await supabase
          .from("agent_numbers")
          .select("id, telnyx_number, is_free, purchased_at")
          .eq("agent_id", uid)
          .order("purchased_at", { ascending: true });

        const normalized = (nums || [])
          .map(n => ({ ...n, telnyx_number: toE164(n.telnyx_number) }))
          .filter(n => !!n.telnyx_number);

        if (mounted) {
          setAgentNums(normalized);
          setSelectedFrom("");
        }
      } finally {
        if (mounted) setLoadMsg("");
      }
    })();
    return () => { mounted = false; };
  }, []);

  async function saveAgentPhoneNormalized() {
    setSaveAgentMsg("");
    const eNum = toE164(agentPhone);
    if (!eNum) {
      setSaveAgentMsg("Enter a valid +1XXXXXXXXXX");
      return;
    }
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;
      await supabase.from("agent_profiles").update({ phone: eNum }).eq("user_id", uid);
      setAgentPhone(eNum);
      setSaveAgentMsg("Saved");
      addTimer(setTimeout(() => setSaveAgentMsg(""), 1200));
    } catch {
      setSaveAgentMsg("Save failed");
      addTimer(setTimeout(() => setSaveAgentMsg(""), 1500));
    }
  }

  // ================================
  // Realtime: auto_dialer_attempts (current run)
  // ================================
  useEffect(() => {
    if (!runId) return;
    let chan;
    (async () => {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId) return;

      chan = supabase
        .channel(`auto_dialer_attempts_live_${runId}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "auto_dialer_attempts", filter: `run_id=eq.${runId}` },
          (payload) => {
            const rec = payload.new || payload.old || {};
            const leadId = rec.contact_id;
            if (!leadId) return;

            const status = (rec.status || "").toLowerCase();
            const mapped =
              status === "dialing" ? "dialing" :
              status === "ringing" ? "ringing" :
              status === "answered" ? "answered" :
              status === "bridged" ? "bridged" :
              status === "completed" ? "completed" :
              status === "failed" ? "failed" :
              status || "dialing";

            setLiveStatus((s) => ({ ...s, [leadId]: mapped }));

            if (isRunningRef.current && (mapped === "completed" || mapped === "failed")) {
              advanceAfterEnd(leadId, mapped);
            }
          }
        )
        .subscribe();
    })();

    return () => { if (chan) supabase.removeChannel(chan); };
  }, [runId]);

  const rowsLookup = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);

  function toggleStage(id) {
    setStageFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function buildQueue() {
    const wantStates = new Set(parseStateFilter(stateFilter)); // empty = all
    const wantStages = stageFilters; // empty = all

    const list = rows
      .filter(r => r.phone)
      .filter(r => (wantStates.size ? wantStates.has((r.state || "").toUpperCase()) : true))
      .filter(r => (wantStages.size ? wantStages.has((r.stage || "no_pickup")) : true))
      .map(r => ({ id: r.id, attempts: 0, status: "queued" }));

    setQueue(list);
    setCurrentIdx(0);
    settledRef.current = new Set();

    const patch = {};
    for (const q of list) patch[q.id] = "queued";
    setLiveStatus((s) => ({ ...s, ...patch }));

    // NEW: create a run
    const settings = {
      stateFilter,
      stageFilters: Array.from(stageFilters),
      maxAttempts,
      selectedFrom,
    };
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData?.user?.id;
    if (uid) {
      const { data: run } = await supabase
        .from("auto_dialer_runs")
        .insert([{ user_id: uid, settings, total_leads: list.length }])
        .select("id")
        .single();
      setRunId(run?.id || null);
      attemptByContactRef.current = new Map();
    }
  }

  function requireBasics() {
    const eAgent = toE164(agentPhone);
    if (!eAgent) {
      alert("Agent phone is missing or invalid. Please enter a valid +1XXXXXXXXXX and save.");
      return null;
    }
    const eFrom = selectedFrom ? toE164(selectedFrom) : null; // blank = server auto-pick / connection default
    return { agent: eAgent, from: eFrom };
  }

  async function startAutoDial() {
    if (!queue.length) {
      await buildQueue();
      addTimer(setTimeout(() => { if (!isRunningRef.current) return; runNext(); }, 0));
    } else {
      runNext();
    }
  }

  function stopAutoDial() {
    setIsRunning(false);
    isRunningRef.current = false;
    clearAllTimers();
  }

  async function runNext() {
    const basics = requireBasics();
    if (!basics) return;

    setIsRunning(true);
    isRunningRef.current = true;

    const idx = currentIdx;
    if (idx >= queue.length) {
      // done
      setIsRunning(false);
      isRunningRef.current = false;
      clearAllTimers();
      // optionally mark run ended
      if (runId) { try { await supabase.from("auto_dialer_runs").update({ ended_at: new Date().toISOString() }).eq("id", runId); } catch {} }
      return;
    }

    const item = queue[idx];
    const lead = rowsLookup.get(item.id);
    if (!lead || !lead.phone) {
      setCurrentIdx((i) => i + 1);
      addTimer(setTimeout(() => { if (!isRunningRef.current) return; runNext(); }, 0));
      return;
    }

    try {
      setLiveStatus((s) => ({ ...s, [item.id]: "dialing" }));
      setQueue((q) => q.map((x, i) => i === idx ? { ...x, status: "dialing" } : x));

      const to = toE164(lead.phone);

      const resp = await startLeadFirstCall({
        agentNumber: basics.agent,
        leadNumber: to,
        contactId: lead.id,
        fromNumber: basics.from,
        record: true,
        ringTimeout: 25,
        ringbackUrl: "",
      });
      // resp: { ok, call_leg_id, call_session_id, contact_id, used_from_number }
      const call_session_id = resp?.call_session_id || null;
      const legA = resp?.call_leg_id || null;

      // NEW: insert attempt row tied to this run
      if (runId) {
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (uid) {
          const { data: attempt } = await supabase
            .from("auto_dialer_attempts")
            .insert([{
              run_id: runId,
              user_id: uid,
              contact_id: lead.id,
              lead_number: to,
              from_number: basics.from,
              agent_number: basics.agent,
              call_session_id,
              telnyx_leg_a_id: legA,
              status: "dialing",
              attempts: (item.attempts || 0) + 1,
            }])
            .select("id")
            .single();

          if (attempt?.id) {
            attemptByContactRef.current.set(lead.id, attempt.id);
          }
        }
      }

      // Optimistic “ringing” fallback
      addTimer(setTimeout(() => {
        if (!isRunningRef.current) return;
        if (liveStatusRef.current[lead.id] === "dialing") {
          setLiveStatus((s) => ({ ...s, [lead.id]: "ringing" }));
        }
      }, 1500));

      // Safety net advance if nothing ends after 70s
      addTimer(setTimeout(() => {
        if (!isRunningRef.current) return;
        const st = liveStatusRef.current[lead.id];
        if (["dialing","ringing","answered","bridged"].includes(st)) {
          advanceAfterEnd(lead.id, "failed");
        }
      }, 70000));
    } catch (e) {
      console.error("lead-first start error:", e?.message || e);
      advanceAfterEnd(item.id, "failed");
    }
  }

  async function advanceAfterEnd(leadId, outcome) {
    // settle once
    const settled = settledRef.current;
    if (settled.has(leadId)) return;
    settled.add(leadId);

    // optional: stamp attempt row outcome immediately
    const attemptId = attemptByContactRef.current.get(leadId);
    if (attemptId) {
      try {
        await supabase.from("auto_dialer_attempts")
          .update({ status: outcome, ended_at: new Date().toISOString() })
          .eq("id", attemptId);
      } catch {}
    }

    setQueue((old) => {
      const idx = currentIdx;
      const cur = old[idx];
      if (!cur || cur.id !== leadId) return old;

      const attempts = (cur.attempts || 0) + 1;
      setLiveStatus((s) => ({ ...s, [leadId]: outcome }));

      if (outcome !== "completed" && attempts < maxAttempts) {
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: "queued" };
        addTimer(setTimeout(() => { if (!isRunningRef.current) return; runNext(); }, 400));
        return updated;
      } else {
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: outcome };
        const nextIdx = idx + 1;
        setCurrentIdx(nextIdx);

        // If that was the last lead, stop cleanly
        if (nextIdx >= updated.length) {
          setIsRunning(false);
          isRunningRef.current = false;
          clearAllTimers();
          if (runId) { try { supabase.from("auto_dialer_runs").update({ ended_at: new Date().toISOString() }).eq("id", runId); } catch {} }
        } else {
          addTimer(setTimeout(() => { if (!isRunningRef.current) return; runNext(); }, 250));
        }
        return updated;
      }
    });
  }

  const stagePills = STAGE_IDS.map((sid) => (
    <button
      key={sid}
      onClick={() => toggleStage(sid)}
      className={`rounded-full px-3 py-1 text-xs border ${
        stageFilters.has(sid) ? "border-white bg-white text-black" : "border-white/20 bg-white/5 text-white/80"
      }`}
      title={labelForStage(sid)}
    >
      {labelForStage(sid)}
    </button>
  ));

  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-4">
      <div className="relative m-auto w-full max-w-3xl rounded-2xl border border-white/15 bg-neutral-950 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-lg font-semibold">Auto Dial</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10">Close</button>
        </div>

        {!!loadMsg && (
          <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.04] p-2 text-xs text-white/70">
            {loadMsg}
          </div>
        )}

        {/* Numbers row: DID picker + editable agent phone */}
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="text-[11px] text-white/60">Caller ID</div>
            <select
              value={selectedFrom}
              onChange={(e)=>setSelectedFrom(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              title="Choose which number prospects will see"
            >
              <option value="">Use connection default</option>
              {agentNums.map(n => (
                <option key={n.id} value={n.telnyx_number}>
                  {maskForList(n.telnyx_number)} {n.is_free ? "(free pool)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="text-[11px] text-white/60">Agent Phone (we connect you)</div>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={agentPhone}
                onChange={(e)=>setAgentPhone(e.target.value)}
                onBlur={saveAgentPhoneNormalized}
                placeholder="+1XXXXXXXXXX"
                className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <button
                type="button"
                onClick={saveAgentPhoneNormalized}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
              >
                Save
              </button>
            </div>
            {!!agentPhone && (
              <div className="mt-1 text-[11px] text-white/40">
                Current: {prettyE164(toE164(agentPhone) || agentPhone)}
              </div>
            )}
            {saveAgentMsg && (
              <div className="mt-1 text-[11px] text-white/60">{saveAgentMsg}</div>
            )}
          </div>
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
          <div className="col-span-2">
            <label className="text-xs text-white/70">Stages (leave empty for ALL)</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {STAGE_IDS.map((sid) => (
                <button
                  key={sid}
                  onClick={() => toggleStage(sid)}
                  className={`rounded-full px-3 py-1 text-xs border ${
                    stageFilters.has(sid) ? "border-white bg-white text-black" : "border-white/20 bg-white/5 text-white/80"
                  }`}
                  title={labelForStage(sid)}
                >
                  {labelForStage(sid)}
                </button>
              ))}
            </div>
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
              onClick={startAutoDial}
              className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm hover:bg-emerald-500/20"
              disabled={!toE164(agentPhone)}
              title={!toE164(agentPhone) ? "Enter a valid agent phone first" : ""}
            >
              Start calling
            </button>
          ) : (
            <button
              onClick={stopAutoDial}
              className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm hover:bg-amber-500/20"
            >
              Pause
            </button>
          )}
          <div className="text-xs text-white/60 ml-2">
            {queue.length ? `Lead ${Math.min(currentIdx + 1, queue.length)} of ${queue.length}` : "No queue yet"}
            {runId ? <span className="ml-3 text-white/40">Run: {runId.slice(0,8)}…</span> : null}
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
