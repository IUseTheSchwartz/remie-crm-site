// File: src/pages/PipelinePage.jsx
import { useEffect, useMemo, useState } from "react";
import {
  Phone, Mail, Clock, StickyNote, Search, Filter,
  MoveRight, MoveLeft, CheckCircle2, AlertCircle, ChevronRight, X,
  Voicemail, ThumbsDown, DollarSign
} from "lucide-react";

import {
  loadLeads, saveLeads,
  loadClients, saveClients,
  normalizePerson, upsert
} from "../lib/storage.js";

/* ---------------------------------- Config --------------------------------- */

const STAGES = [
  { id: "no_pickup",   label: "No Pickup",    hint: "No answer / left VM" },
  { id: "quoted",      label: "Quoted",       hint: "Shared premium/face" },
  { id: "app_started", label: "App Started",  hint: "Began application" },
  { id: "app_pending", label: "App Pending",  hint: "Waiting on UW/docs" },
];

// Simple badge colors per stage
const STAGE_STYLE = {
  no_pickup:   "bg-white/10 text-white/80",
  quoted:      "bg-amber-500/15 text-amber-300",
  app_started: "bg-indigo-500/15 text-indigo-300",
  app_pending: "bg-fuchsia-500/15 text-fuchsia-300",
};

// Quick suggestions for next follow-up (hours from now)
const FOLLOWUP_SUGGESTIONS = [
  { label: "Today PM", hours: 4 },
  { label: "Tomorrow AM", hours: 24 },
  { label: "Next Week", hours: 24 * 7 },
];

/* ------------------------------- Notes storage ----------------------------- */

// Lightweight notes store in localStorage, keyed by lead.id
const NOTES_KEY = "remie_notes_v1";
function loadNotesMap() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); }
  catch { return {}; }
}
function saveNotesMap(m) {
  localStorage.setItem(NOTES_KEY, JSON.stringify(m));
}

/* ------------------------------ Helper functions --------------------------- */

function nowIso() { return new Date().toISOString(); }

function ensurePipelineDefaults(person) {
  // Skip sold contacts from the working board
  if (person.status === "sold") return person;

  const patch = { ...person };
  if (!patch.stage) patch.stage = "no_pickup";
  if (!patch.stage_changed_at) patch.stage_changed_at = nowIso();
  if (patch.call_attempts == null) patch.call_attempts = 0;
  if (!patch.last_outcome) patch.last_outcome = "";
  if (!patch.priority) patch.priority = "medium";
  // Space for storing quote/app info without changing your existing Sold flow
  patch.pipeline = patch.pipeline || {
    quote: { carrier: "", face: "", premium: "" },
    pending: { reason: "" },
  };
  return patch;
}

function mergeAndSave(updated, clients, leads) {
  // Upsert into both lists; keep your existing storage approach
  const nextClients = upsert(clients, updated);
  const nextLeads   = upsert(leads, updated);
  saveClients(nextClients);
  saveLeads(nextLeads);
  return { nextClients, nextLeads };
}

function telHref(s) {
  const d = String(s || "").replace(/[^\d+]/g, "");
  return d ? `tel:${d}` : "#";
}
function mailHref(s) {
  const m = String(s || "").trim();
  return m ? `mailto:${m}` : "#";
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch { return "—"; }
}

function daysInStage(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const d = Math.max(0, Math.round(ms / 86400000));
    return d === 0 ? "today" : `${d}d`;
  } catch { return "—"; }
}

/* --------------------------------- Component -------------------------------- */

export default function PipelinePage() {
  // Core data
  const [leads, setLeads] = useState([]);
  const [clients, setClients] = useState([]);

  // UI state
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null); // currently opened card (drawer)
  const [notesMap, setNotesMap] = useState(loadNotesMap());
  const [showFilters, setShowFilters] = useState(false);

  // Load from your existing local storage
  useEffect(() => {
    const L = loadLeads();
    const C = loadClients();
    setLeads(L);
    setClients(C);
  }, []);

  // Build deduped collection (like your Leads view), excluding sold
  const all = useMemo(() => {
    const map = new Map();
    for (const x of clients) if (x.status !== "sold") map.set(x.id, ensurePipelineDefaults(x));
    for (const y of leads)   if (y.status !== "sold") map.set(y.id, ensurePipelineDefaults(y));
    return Array.from(map.values());
  }, [clients, leads]);

  // Filter by search text
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(p =>
      [p.name, p.phone, p.email, p.state, p.last_outcome]
        .some(v => (v || "").toString().toLowerCase().includes(q))
    );
  }, [all, filter]);

  // Group into lanes
  const lanes = useMemo(() => {
    const out = Object.fromEntries(STAGES.map(s => [s.id, []]));
    for (const p of filtered) {
      const key = STAGE_STYLE[p.stage] ? p.stage : "no_pickup";
      out[key].push(p);
    }
    // Sort by next follow up (so the soonest is top) then by days in stage
    for (const id of Object.keys(out)) {
      out[id].sort((a,b) => {
        const na = a.next_follow_up_at ? new Date(a.next_follow_up_at).getTime() : Infinity;
        const nb = b.next_follow_up_at ? new Date(b.next_follow_up_at).getTime() : Infinity;
        if (na !== nb) return na - nb;
        const da = new Date(a.stage_changed_at || 0).getTime();
        const db = new Date(b.stage_changed_at || 0).getTime();
        return da - db;
      });
    }
    return out;
  }, [filtered]);

  /* ---------------------------- Mutations / actions --------------------------- */

  function openCard(p) { setSelected(p); }

  function updatePerson(patch) {
    const base = normalizePerson(patch);
    const { nextClients, nextLeads } = mergeAndSave(base, clients, leads);
    setClients(nextClients);
    setLeads(nextLeads);
    // also refresh selected if open
    if (selected?.id === base.id) setSelected(base);
  }

  function moveStage(person, stage) {
    if (!STAGE_STYLE[stage]) stage = "no_pickup";
    updatePerson({ ...person, stage, stage_changed_at: nowIso() });
  }

  function setOutcome(person, outcome, extra = {}) {
    const patch = { ...person, last_outcome: outcome };
    // smart increments for some outcomes
    if (outcome === "no_answer" || outcome === "left_vm") {
      patch.call_attempts = (person.call_attempts || 0) + 1;
      // stay in no_pickup unless they were elsewhere
      patch.stage = "no_pickup";
    }
    if (outcome === "quoted") {
      patch.stage = "quoted";
      patch.pipeline = { ...(person.pipeline || {}), quote: {
        carrier: extra.carrier || person?.pipeline?.quote?.carrier || "",
        face: extra.face || person?.pipeline?.quote?.face || "",
        premium: extra.premium || person?.pipeline?.quote?.premium || "",
      }};      
    }
    if (outcome === "app_started") {
      patch.stage = "app_started";
    }
    if (outcome === "app_pending") {
      patch.stage = "app_pending";
      patch.pipeline = {
        ...(person.pipeline || {}),
        pending: { reason: extra.reason || person?.pipeline?.pending?.reason || "" }
      };
    }
    if (outcome === "not_interested") {
      patch.pipeline = { ...(person.pipeline || {}), lost_reason: extra.lost_reason || "" };
      patch.stage = "no_pickup"; // keep it off-board by simply letting filters hide it, or set a flag
      patch.status = "lost";
    }
    if (outcome === "sold") {
      // Minimal: mark as sold; you can fill full policy later on Leads page
      patch.status = "sold";
    }

    patch.stage_changed_at = nowIso();
    updatePerson(patch);

    // auto-note
    const msg = autoNoteForOutcome(outcome, extra);
    if (msg) addNote(person.id, msg, true);
  }

  function setNextFollowUp(person, dateIso) {
    updatePerson({ ...person, next_follow_up_at: dateIso || null });
  }

  /* ---------------------------------- Notes ---------------------------------- */

  function notesFor(id) {
    return (notesMap[id] || []).slice().sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  }
  function addNote(id, body, auto = false) {
    if (!id || !body) return;
    const m = loadNotesMap();
    const arr = m[id] || [];
    arr.push({ id: crypto.randomUUID(), body, auto, pinned: false, created_at: nowIso() });
    m[id] = arr;
    saveNotesMap(m);
    setNotesMap(m);
  }
  function deleteNote(id, noteId) {
    const m = loadNotesMap();
    m[id] = (m[id] || []).filter(n => n.id !== noteId);
    saveNotesMap(m);
    setNotesMap(m);
  }
  function pinNote(id, noteId, pinned) {
    const m = loadNotesMap();
    m[id] = (m[id] || []).map(n => n.id === noteId ? { ...n, pinned } : n);
    saveNotesMap(m);
    setNotesMap(m);
  }

  /* --------------------------------- Render ---------------------------------- */

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-white/40" />
          <input
            className="w-72 rounded-xl border border-white/10 bg-black/40 pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            placeholder="Search name, phone, email, state…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button
          onClick={() => setShowFilters(v => !v)}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
        >
          <Filter className="h-4 w-4" /> Filters
        </button>
        <div className="ml-auto text-xs text-white/60">
          {STAGES.map(s => {
            const count = lanes[s.id]?.length || 0;
            return (
              <span key={s.id} className="mr-3">
                <span className={`rounded-full px-2 py-0.5 ${STAGE_STYLE[s.id]}`}>{s.label}</span> {count}
              </span>
            );
          })}
        </div>
      </div>

      {/* Kanban board */}
      <div className="grid gap-4 md:grid-cols-4">
        {STAGES.map((stage) => (
          <Lane
            key={stage.id}
            stage={stage}
            people={lanes[stage.id] || []}
            onDropCard={(id) => {
              const person = all.find(p => p.id === id);
              if (person) moveStage(person, stage.id);
            }}
            onOpen={openCard}
          />
        ))}
      </div>

      {/* Drawer */}
      {selected && (
        <Drawer
          person={selected}
          onClose={() => setSelected(null)}
          onOutcome={setOutcome}
          onNextFollowUp={setNextFollowUp}
          notes={notesFor(selected.id)}
          onAddNote={(body) => addNote(selected.id, body, false)}
          onDeleteNote={(noteId) => deleteNote(selected.id, noteId)}
          onPinNote={(noteId, pinned) => pinNote(selected.id, noteId, pinned)}
        />
      )}
    </div>
  );
}

/* --------------------------------- Subparts -------------------------------- */

function Lane({ stage, people, onDropCard, onOpen }) {
  return (
    <div
      className="min-h-[420px] rounded-2xl border border-white/10 bg-white/[0.03] p-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDropCard(id);
      }}
    >
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="text-sm font-medium">
          {stage.label}
          <span className="ml-2 text-xs text-white/50">{stage.hint}</span>
        </div>
      </div>
      <div className="grid gap-2">
        {people.map((p) => (
          <Card key={p.id} person={p} onOpen={() => onOpen(p)} />
        ))}
        {people.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-white/50">
            Drag leads here
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ person, onOpen }) {
  const badge = STAGE_STYLE[person.stage] || "bg-white/10 text-white/80";
  const next = person.next_follow_up_at ? fmtDateTime(person.next_follow_up_at) : "—";
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", person.id)}
      className="cursor-grab active:cursor-grabbing rounded-xl border border-white/10 bg-black/40 p-3 hover:bg-black/50"
    >
      <div className="flex items-start justify-between">
        <div className="font-medium">{person.name || person.email || person.phone || "Unnamed"}</div>
        <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${badge}`}>{labelForStage(person.stage)}</span>
      </div>
      <div className="mt-1 text-xs text-white/70 space-y-1">
        {person.phone && (
          <div className="flex items-center gap-1">
            <Phone className="h-3.5 w-3.5" />
            <a href={telHref(person.phone)} className="hover:underline">{person.phone}</a>
          </div>
        )}
        {person.email && (
          <div className="flex items-center gap-1">
            <Mail className="h-3.5 w-3.5" />
            <a href={mailHref(person.email)} className="hover:underline">{person.email}</a>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <span>Next: {next}</span>
          <span className="ml-auto text-white/40">Age: {daysInStage(person.stage_changed_at)}</span>
        </div>
      </div>
      <button
        onClick={onOpen}
        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
      >
        <StickyNote className="h-3.5 w-3.5" />
        Open
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Drawer({ person, onClose, onOutcome, onNextFollowUp, notes, onAddNote, onDeleteNote, onPinNote }) {
  const [noteText, setNoteText] = useState("");
  const [quote, setQuote] = useState({
    carrier: person?.pipeline?.quote?.carrier || "",
    face: person?.pipeline?.quote?.face || "",
    premium: person?.pipeline?.quote?.premium || "",
  });
  const [pendingReason, setPendingReason] = useState(person?.pipeline?.pending?.reason || "");
  const [followPick, setFollowPick] = useState("");

  function addFollowFromPick(hours) {
    const t = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    onNextFollowUp(person, t);
  }

  return (
    <div className="fixed inset-0 z-40 grid bg-black/60 p-2 md:p-4">
      <div className="relative ml-auto h-full w-full max-w-xl rounded-2xl border border-white/15 bg-neutral-950">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-lg font-semibold">{person.name || "Unnamed"}</div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-white/70">
              {person.phone && (
                <a href={telHref(person.phone)} className="inline-flex items-center gap-1 hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {person.phone}
                </a>
              )}
              {person.email && (
                <a href={mailHref(person.email)} className="inline-flex items-center gap-1 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {person.email}
                </a>
              )}
              <span className={`rounded-full px-2 py-0.5 ${STAGE_STYLE[person.stage] || "bg-white/10 text-white/80"}`}>
                {labelForStage(person.stage)}
              </span>
              <span className="text-white/40">In stage: {daysInStage(person.stage_changed_at)}</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-white/15 p-1 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Outcome bar */}
        <div className="grid grid-cols-2 gap-2 border-b border-white/10 p-3 text-xs sm:grid-cols-3">
          <OutcomeBtn label="No Answer"    icon={AlertCircle} onClick={() => onOutcome(person, "no_answer")} />
          <OutcomeBtn label="Left VM"      icon={Voicemail}   onClick={() => onOutcome(person, "left_vm")} />
          <OutcomeBtn label="Quoted"       icon={DollarSign}  onClick={() => onOutcome(person, "quoted", quote)} />
          <OutcomeBtn label="App Started"  icon={MoveRight}   onClick={() => onOutcome(person, "app_started")} />
          <OutcomeBtn label="App Pending"  icon={MoveLeft}    onClick={() => onOutcome(person, "app_pending", { reason: pendingReason })} />
          <OutcomeBtn label="Not Interested" icon={ThumbsDown} onClick={() => {
            const reason = prompt("Reason (optional)?") || "";
            onOutcome(person, "not_interested", { lost_reason: reason });
          }} />
        </div>

        {/* Follow-up quick picks */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
          <div className="text-xs text-white/60">Next follow-up:</div>
          {FOLLOWUP_SUGGESTIONS.map(s => (
            <button key={s.label}
              onClick={() => addFollowFromPick(s.hours)}
              className="rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10">
              {s.label}
            </button>
          ))}
          <input
            type="datetime-local"
            className="ml-auto rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-indigo-500/40"
            value={followPick}
            onChange={(e) => setFollowPick(e.target.value)}
            onBlur={() => {
              if (followPick) {
                const iso = new Date(followPick).toISOString();
                onNextFollowUp(person, iso);
              }
            }}
          />
          <div className="text-xs text-white/50">
            Current: {person.next_follow_up_at ? fmtDateTime(person.next_follow_up_at) : "—"}
          </div>
        </div>

        {/* Body: two columns on wide screens */}
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          {/* Notes */}
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">Notes</div>
            </div>
            <div className="grid gap-2">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a quick note about the call…"
                className="min-h-[72px] w-full rounded-lg border border-white/10 bg-black/40 p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <div className="flex items-center justify-between">
                <button
                  onClick={() => { if (noteText.trim()) { onAddNote(noteText.trim()); setNoteText(""); } }}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/10"
                >
                  Add note
                </button>
                <div className="text-xs text-white/50">{notes.length} note{notes.length === 1 ? "" : "s"}</div>
              </div>
              <div className="mt-1 grid gap-2">
                {notes.map(n => (
                  <div key={n.id} className="rounded-lg border border-white/10 bg-black/30 p-2">
                    <div className="mb-1 flex items-center justify-between text-xs text-white/60">
                      <span>{new Date(n.created_at).toLocaleString()}</span>
                      <div className="flex items-center gap-2">
                        <button onClick={() => onPinNote(n.id, !n.pinned)} className="hover:underline">
                          {n.pinned ? "Unpin" : "Pin"}
                        </button>
                        {!n.auto && (
                          <button onClick={() => onDeleteNote(n.id)} className="text-rose-300 hover:underline">Delete</button>
                        )}
                      </div>
                    </div>
                    <div className={`text-sm ${n.auto ? "text-white/75 italic" : ""}`}>{n.body}</div>
                  </div>
                ))}
                {notes.length === 0 && (
                  <div className="text-xs text-white/50">No notes yet.</div>
                )}
              </div>
            </div>
          </section>

          {/* Details / mini-forms */}
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 text-sm font-medium">Details</div>
            <div className="grid gap-2 text-sm">
              <div className="text-xs text-white/60">Stage</div>
              <div className="flex flex-wrap gap-2">
                {STAGES.map(s => (
                  <span key={s.id} className={`cursor-default rounded-full px-2 py-0.5 text-xs ${STAGE_STYLE[s.id]} ${person.stage === s.id ? "ring-1 ring-white/30" : "opacity-60"}`}>
                    {s.label}
                  </span>
                ))}
              </div>

              {/* Quote quick fields */}
              <div className="mt-3 text-xs text-white/60">Quote (optional)</div>
              <div className="grid grid-cols-3 gap-2">
                <input className="inp" placeholder="Carrier"
                  value={quote.carrier} onChange={(e)=>setQuote({...quote, carrier: e.target.value})} />
                <input className="inp" placeholder="Face"
                  value={quote.face} onChange={(e)=>setQuote({...quote, face: e.target.value})} />
                <input className="inp" placeholder="Premium"
                  value={quote.premium} onChange={(e)=>setQuote({...quote, premium: e.target.value})} />
              </div>
              <button
                onClick={() => onOutcome(person, "quoted", quote)}
                className="mt-1 inline-flex items-center gap-2 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
              >
                <CheckCircle2 className="h-4 w-4" /> Save Quote & mark Quoted
              </button>

              {/* Pending reason */}
              <div className="mt-3 text-xs text-white/60">Pending reason</div>
              <input className="inp" placeholder="Underwriting / APS / eSign…"
                value={pendingReason} onChange={(e)=>setPendingReason(e.target.value)} />
              <button
                onClick={() => onOutcome(person, "app_pending", { reason: pendingReason })}
                className="mt-1 inline-flex items-center gap-2 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
              >
                <CheckCircle2 className="h-4 w-4" /> Save reason & mark Pending
              </button>

              {/* Sold / Lost quick links */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => onOutcome(person, "sold")}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/15">
                  Mark Sold
                </button>
                <button
                  onClick={() => {
                    const reason = prompt("Reason (optional)?") || "";
                    onOutcome(person, "not_interested", { lost_reason: reason });
                  }}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/15">
                  Mark Lost
                </button>
              </div>
            </div>
          </section>
        </div>

        <style>{`.inp{width:100%; border-radius:.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.45rem .6rem; outline:none}
        .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
      </div>
    </div>
  );
}

/* ------------------------------- Tiny helpers ------------------------------ */

function OutcomeBtn({ label, icon:Icon, onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 hover:bg-white/10"
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

function labelForStage(id) {
  const m = {
    no_pickup: "No Pickup",
    quoted: "Quoted",
    app_started: "App Started",
    app_pending: "App Pending",
  };
  return m[id] || "No Pickup";
}

function autoNoteForOutcome(type, extra) {
  switch (type) {
    case "no_answer": return "Outcome: No answer. Will retry.";
    case "left_vm": return "Outcome: Left voicemail.";
    case "quoted": {
      const { carrier, face, premium } = (extra || {});
      const parts = [];
      if (carrier) parts.push(`Carrier ${carrier}`);
      if (face) parts.push(`Face ${face}`);
      if (premium) parts.push(`Premium ${premium}`);
      return `Outcome: Quoted. ${parts.join(", ")}`.trim();
    }
    case "app_started": return "Outcome: Application started.";
    case "app_pending": {
      const reason = extra?.reason ? ` (${extra.reason})` : "";
      return `Outcome: App pending${reason}.`;
    }
    case "not_interested": {
      const r = extra?.lost_reason ? ` Reason: ${extra.lost_reason}` : "";
      return `Outcome: Not interested.${r}`;
    }
    case "sold": return "Outcome: Sold (marked).";
    default: return "";
  }
}
