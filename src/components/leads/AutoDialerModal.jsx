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
    .split(/[\s,]+/)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

async function withAuthHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAssignedDid() {
  // Mirrors MessagingSettings' use of the function
  const headers = await withAuthHeaders();
  const res = await fetch("/.netlify/functions/ten-dlc-status", { headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `HTTP_${res.status}`);
  return j?.phone_number || null; // expect E.164 or raw; we normalize below
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

  // Live call status by contact_id
  const [liveStatus, setLiveStatus] = useState({});
  const liveStatusRef = useRef({});
  useEffect(() => { liveStatusRef.current = liveStatus; }, [liveStatus]);

  // Auto-loaded agent phone & assigned DID
  const [agentPhone, setAgentPhone] = useState("");
  const [callerId, setCallerId] = useState(""); // assigned DID (hidden)
  const [loadMsg, setLoadMsg] = useState("");

  // Load agent phone (normalize & persist if needed) and assigned DID
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadMsg("Loading agent and number…");
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (!uid) return;

        // Agent phone
        const { data: profile } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", uid)
          .maybeSingle();

        let num = profile?.phone || "";
        const eNum = toE164(num);
        if (eNum && eNum !== num) {
          // persist normalized
          try { await supabase.from("agent_profiles").update({ phone: eNum }).eq("user_id", uid); } catch {}
          num = eNum;
        }
        if (mounted && num) setAgentPhone(num);

        // Assigned DID (from your 10DLC status function)
        let did = null;
        try {
          const pn = await fetchAssignedDid();
          did = toE164(pn);
        } catch {}
        if (mounted && did) setCallerId(did);

      } finally {
        if (mounted) setLoadMsg("");
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Realtime: call_logs -> update live status + auto-advance
  useEffect(() => {
    let chan;
    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        chan = supabase.channel("call_logs_live_dialer")
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

              if (isRunningRef.current && (mapped === "completed" || mapped === "failed")) {
                advanceAfterEnd(leadId, mapped);
              }
            })
          .subscribe();
      } catch {}
    })();
    return () => { if (chan) supabase.removeChannel(chan); };
  }, []);

  const rowsLookup = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);

  function toggleStage(id) {
    setStageFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function buildQueue() {
    const wantStates = new Set(parseStateFilter(stateFilter)); // empty = all
    const wantStages = stageFilters; // empty = all

    const list = rows
      .filter(r => r.phone)
      .filter(r => (wantStates.size ? wantStates.has((r.state || "").toUpperCase()) : true))
      .filter(r => (wantStages.size ? wantStages.has((r.stage || "no_pickup")) : true))
      .map(r => ({ id: r.id, attempts: 0, status: "queued" }));

    setQueue(list);
    setCurrentIdx(0);

    const patch = {};
    for (const q of list) patch[q.id] = "queued";
    setLiveStatus((s) => ({ ...s, ...patch }));
  }

  function requireLoadedBasics() {
    const eAgent = toE164(agentPhone);
    const eCaller = toE164(callerId);
    if (!eAgent) {
      alert("Agent phone is missing in your profile. Add it in Settings → Profile.");
      return null;
    }
    if (!eCaller) {
      alert("Your assigned caller ID (messaging number) isn’t set yet. Go to Messaging Settings and assign a number.");
      return null;
    }
    return { agent: eAgent, caller: eCaller };
  }

  async function startAutoDial() {
    if (!queue.length) {
      buildQueue();
      setTimeout(() => runNext(), 0);
    } else {
      runNext();
    }
  }

  function stopAutoDial() {
    setIsRunning(false);
    isRunningRef.current = false;
  }

  async function runNext() {
    const basics = requireLoadedBasics();
    if (!basics) return;

    setIsRunning(true);
    isRunningRef.current = true;

    const idx = currentIdx;
    if (idx >= queue.length) {
      setIsRunning(false);
      isRunningRef.current = false;
      return;
    }

    const item = queue[idx];
    const lead = rowsLookup.get(item.id);
    if (!lead || !lead.phone) {
      setCurrentIdx((i) => i + 1);
      setTimeout(runNext, 0);
      return;
    }

    try {
      setLiveStatus((s) => ({ ...s, [item.id]: "dialing" }));
      setQueue((q) => q.map((x, i) => i === idx ? { ...x, status: "dialing" } : x));

      const to = toE164(lead.phone);

      await startLeadFirstCall({
        agentNumber: basics.agent,
        leadNumber: to,
        contactId: lead.id,
        fromNumber: basics.caller, // assigned DID
        record: true,
        ringTimeout: 25,
        ringbackUrl: "", // optional
      });

      // Optimistic “ringing” fallback
      setTimeout(() => {
        if (liveStatusRef.current[lead.id] === "dialing") {
          setLiveStatus((s) => ({ ...s, [lead.id]: "ringing" }));
        }
      }, 1500);

      // Safety net advance if nothing ends after 70s
      setTimeout(() => {
        const st = liveStatusRef.current[lead.id];
        if (isRunningRef.current && ["dialing","ringing","answered","bridged"].includes(st)) {
          advanceAfterEnd(lead.id, "failed");
        }
      }, 70000);
    } catch {
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
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: "queued" };
        setTimeout(runNext, 500);
        return updated;
      } else {
        const updated = [...old];
        updated[idx] = { ...cur, attempts, status: outcome };
        setCurrentIdx((i) => i + 1);
        setTimeout(runNext, 300);
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

        {!callerId && (
          <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
            No assigned caller ID found. Go to <b>Messaging Settings</b> and assign a verified number.
          </div>
        )}

        {!agentPhone && (
          <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
            Your agent phone is missing. Add it in <b>Settings → Profile</b>.
          </div>
        )}

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
              {stagePills}
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
