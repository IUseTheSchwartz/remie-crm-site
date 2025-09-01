// File: src/pages/PipelinePage.jsx
import { useEffect, useMemo, useState } from "react";
import {
  Phone, Mail, Clock, StickyNote, Search, Filter,
  CheckCircle2, ChevronRight, X, Trash2
} from "lucide-react";

import {
  loadLeads, saveLeads,
  loadClients, saveClients,
  normalizePerson
} from "../lib/storage.js";

/* ---------------------------------- Config --------------------------------- */

const STAGES = [
  { id: "no_pickup",   label: "No Pickup",    hint: "No answer / left VM" },
  { id: "quoted",      label: "Quoted",       hint: "Shared premium/face" },
  { id: "app_started", label: "App Started",  hint: "Began application" },
  { id: "app_pending", label: "App Pending",  hint: "Waiting on UW/docs" },
];

const STAGE_STYLE = {
  no_pickup:   "bg-white/10 text-white/80",
  quoted:      "bg-amber-500/15 text-amber-300",
  app_started: "bg-indigo-500/15 text-indigo-300",
  app_pending: "bg-fuchsia-500/15 text-fuchsia-300",
};

/* ------------------------------- Notes storage ----------------------------- */

const NOTES_KEY = "remie_notes_v1";
function loadNotesMap() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); }
  catch { return {}; }
}
function saveNotesMap(m) { localStorage.setItem(NOTES_KEY, JSON.stringify(m)); }

/* ------------------------------ Helper functions --------------------------- */

function nowIso() { return new Date().toISOString(); }

/** Preserve custom fields (stage, pipeline, etc.) when normalizing. */
function ensurePipelineDefaults(person) {
  const base = { ...normalizePerson(person), ...person }; // keep custom fields
  const patch = { ...base };
  if (patch.status === "sold") return patch;

  if (!patch.stage) patch.stage = "no_pickup";
  if (!patch.stage_changed_at) patch.stage_changed_at = nowIso();
  if (patch.call_attempts == null) patch.call_attempts = 0;
  if (!patch.last_outcome) patch.last_outcome = "";
  if (!patch.priority) patch.priority = "medium";
  patch.pipeline = patch.pipeline || {
    quote: { carrier: "", face: "", premium: "" },
    pending: { reason: "" },
  };
  return patch;
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

function toLocalInputValue(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
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
  const [leads, setLeads] = useState([]);
  const [clients, setClients] = useState([]);

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [notesMap, setNotesMap] = useState(loadNotesMap());
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setLeads(loadLeads());
    setClients(loadClients());
  }, []);

  // Combine both lists and pick the FRESHEST copy per id
  const all = useMemo(() => {
    const byId = new Map();
    const pickFresh = (existing, incoming) => {
      const te = existing?.stage_changed_at ? new Date(existing.stage_changed_at).getTime() : -1;
      const ti = incoming?.stage_changed_at ? new Date(incoming.stage_changed_at).getTime() : -1;
      return ti > te ? incoming : existing;
    };
    [...clients, ...leads].forEach((raw) => {
      if (!raw || raw.status === "sold") return;
      const p = ensurePipelineDefaults(raw);
      const cur = byId.get(p.id);
      byId.set(p.id, cur ? pickFresh(cur, p) : p);
    });
    return Array.from(byId.values());
  }, [clients, leads]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(p =>
      [p.name, p.phone, p.email, p.state, p.last_outcome]
        .some(v => (v || "").toString().toLowerCase().includes(q))
    );
  }, [all, filter]);

  const lanes = useMemo(() => {
    const out = Object.fromEntries(STAGES.map(s => [s.id, []]));
    for (const p of filtered) {
      const key = STAGE_STYLE[p.stage] ? p.stage : "no_pickup";
      out[key].push(p);
    }
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

  // Deterministic save that replaces by id in BOTH lists
  function updatePerson(patch) {
    const item = { ...patch };

    const replaceById = (list, obj) => {
      const idx = list.findIndex((x) => x.id === obj.id);
      if (idx >= 0) {
        const copy = list.slice();
        copy[idx] = obj;
        // Ensure only one copy by id
        return copy.filter((x, i) => i === copy.findIndex(y => y.id === x.id));
      }
      return [obj, ...list.filter((x) => x.id !== obj.id)];
    };

    const nextClients = replaceById(clients, item);
    const nextLeads   = replaceById(leads, item);

    saveClients(nextClients);
    saveLeads(nextLeads);

    setClients(nextClients);
    setLeads(nextLeads);

    if (selected?.id === item.id) setSelected(item);
  }

  function setStage(person, stage) {
    const safe = STAGE_STYLE[stage] ? stage : "no_pickup";
    updatePerson({ ...person, stage: safe, stage_changed_at: nowIso() });
    autoNoteForStageChange(person, safe);
  }

  function setNextFollowUp(person, dateIso) {
    updatePerson({ ...person, next_follow_up_at: dateIso || null });
  }

  function openCard(p) { setSelected(p); }

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

      {/* Board */}
      <div className="grid gap-4 md:grid-cols-4">
        {STAGES.map((stage) => (
          <Lane
            key={stage.id}
            stage={stage}
            people={lanes[stage.id] || []}
            onOpen={openCard}
            onMoveTo={(id, dest) => {
              const p = all.find(x => x.id === id);
              if (p) setStage(p, dest);
            }}
          />
        ))}
      </div>

      {/* Drawer */}
      {selected && (
        <Drawer
          person={selected}
          onClose={() => setSelected(null)}
          onSetStage={setStage}
          onUpdate={updatePerson}
          onNextFollowUp={setNextFollowUp}
          notes={notesFor(selected.id)}
          onAddNote={(body) => addNote(selected.id, body, false)}
          onDeleteNote={(pid, noteId) => deleteNote(pid, noteId)}
          onPinNote={(pid, noteId, pinned) => pinNote(pid, noteId, pinned)}
        />
      )}
    </div>
  );
}

/* --------------------------------- Subparts -------------------------------- */

function Lane({ stage, people, onOpen, onMoveTo }) {
  return (
    <div className="min-h-[420px] rounded-2xl border border-white/10 bg-white/[0.03] p-2">
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="text-sm font-medium">
          {stage.label}
          <span className="ml-2 text-xs text-white/50">{stage.hint}</span>
        </div>
      </div>

      <div className="grid gap-2 min-h-[300px]">
        {people.map((p) => (
          <Card
            key={p.id}
            person={p}
            onOpen={() => onOpen(p)}
            onMoveTo={(dest) => onMoveTo(p.id, dest)}
          />
        ))}
        {people.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-white/50">
            No leads in this stage
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ person, onOpen }) {
  const badge = STAGE_STYLE[person.stage] || "bg-white/10 text-white/80";
  const next = person.next_follow_up_at ? fmtDateTime(person.next_follow_up_at) : "—";

  // FIXED HEIGHT + truncation so all cards match the No Pickup column
  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-3 hover:bg-black/50 h-[150px] flex flex-col">
      <div className="flex-1 min-h-0">
        <div className="flex items-start justify-between gap-2">
          <div className="font-medium truncate max-w-[70%]">
            {person.name || person.email || person.phone || "Unnamed"}
          </div>
          <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs ${badge}`}>
            {labelForStage(person.stage)}
          </span>
        </div>

        <div className="mt-1 text-xs text-white/70 space-y-1 overflow-hidden">
          {person.phone && (
            <div className="flex items-center gap-1">
              <Phone className="h-3.5 w-3.5 shrink-0" />
              <a href={telHref(person.phone)} className="hover:underline truncate">{person.phone}</a>
            </div>
          )}
          {person.email && (
            <div className="flex items-center gap-1">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <a href={mailHref(person.email)} className="hover:underline truncate">{person.email}</a>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Next: {next}</span>
            <span className="ml-auto text-white/40">Age: {daysInStage(person.stage_changed_at)}</span>
          </div>
        </div>
      </div>

      <div className="pt-2">
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
        >
          <StickyNote className="h-3.5 w-3.5" />
          Open
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Drawer({
  person, onClose, onSetStage, onUpdate, onNextFollowUp,
  notes, onAddNote, onDeleteNote, onPinNote
}) {
  const [noteText, setNoteText] = useState("");
  const [quote, setQuote] = useState({
    carrier: person?.pipeline?.quote?.carrier || "",
    face: person?.pipeline?.quote?.face || "",
    premium: person?.pipeline?.quote?.premium || "",
  });
  const [pendingReason, setPendingReason] = useState(person?.pipeline?.pending?.reason || "");
  const [followPick, setFollowPick] = useState(toLocalInputValue(person?.next_follow_up_at || ""));
  const [selectedStage, setSelectedStage] = useState(person.stage);

  const StageChip = ({ id, children }) => (
    <button
      onClick={() => setSelectedStage(id)}
      className={`rounded-full px-3 py-1 text-xs border ${
        selectedStage === id
          ? "bg-white text-black border-white/10"
          : "bg-white/5 text-white border-white/15 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );

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

        {/* STAGE PICKER + SAVE */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
          <div className="text-xs text-white/60 mr-1">Stage:</div>
          <StageChip id="no_pickup">No Pickup</StageChip>
          <StageChip id="quoted">Quoted</StageChip>
          <StageChip id="app_started">App Started</StageChip>
          <StageChip id="app_pending">App Pending</StageChip>

          <button
            onClick={() => onSetStage(person, selectedStage)}
            disabled={selectedStage === person.stage}
            className={`ml-auto rounded-lg border px-3 py-1.5 text-xs ${
              selectedStage === person.stage
                ? "cursor-not-allowed border-white/10 text-white/40"
                : "border-white/15 bg-white/5 hover:bg-white/10"
            }`}
            title={selectedStage === person.stage ? "No changes to save" : "Save stage"}
          >
            Save stage
          </button>
        </div>

        {/* Follow-up: manual only */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <div className="text-xs text-white/60">Next follow-up:</div>
          <input
            type="datetime-local"
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-indigo-500/40"
            value={followPick}
            onChange={(e) => setFollowPick(e.target.value)}
          />
          <button
            onClick={() => {
              const iso = followPick ? new Date(followPick).toISOString() : null;
              onNextFollowUp(person, iso);
            }}
            className="ml-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/10"
          >
            Save follow-up
          </button>
          <div className="ml-auto text-xs text-white/50">
            Current: {person.next_follow_up_at ? fmtDateTime(person.next_follow_up_at) : "—"}
          </div>
        </div>

        {/* Body */}
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
                  onClick={() => { if (noteText.trim()) { onAddNote(person.id, noteText.trim()); setNoteText(""); } }}
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
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => onPinNote(person.id, n.id, !n.pinned)}
                          className="hover:underline"
                          title={n.pinned ? "Unpin" : "Pin"}
                        >
                          {n.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          onClick={() => onDeleteNote(person.id, n.id)}
                          title="Delete note"
                          className="text-rose-300 hover:text-rose-200"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
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

          {/* Details */}
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 text-sm font-medium">Details</div>
            <div className="grid gap-2 text-sm">
              <div className="text-xs text-white/60">Current stage</div>
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
                onClick={() => {
                  onUpdate({
                    ...person,
                    stage: "quoted",
                    stage_changed_at: nowIso(),
                    pipeline: {
                      ...(person.pipeline || {}),
                      quote: { ...quote },
                    },
                  });
                }}
                className="mt-1 inline-flex items-center gap-2 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
              >
                <CheckCircle2 className="h-4 w-4" /> Save Quote & mark Quoted
              </button>

              {/* Pending reason */}
              <div className="mt-3 text-xs text-white/60">Pending reason</div>
              <input className="inp" placeholder="Underwriting / APS / eSign…"
                value={pendingReason} onChange={(e)=>setPendingReason(e.target.value)} />
              <button
                onClick={() => {
                  onUpdate({
                    ...person,
                    stage: "app_pending",
                    stage_changed_at: nowIso(),
                    pipeline: {
                      ...(person.pipeline || {}),
                      pending: { reason: pendingReason },
                    },
                  });
                }}
                className="mt-1 inline-flex items-center gap-2 rounded-lg border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
              >
                <CheckCircle2 className="h-4 w-4" /> Save reason & mark Pending
              </button>
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

function labelForStage(id) {
  const m = {
    no_pickup: "No Pickup",
    quoted: "Quoted",
    app_started: "App Started",
    app_pending: "App Pending",
  };
  return m[id] || "No Pickup";
}

function autoNoteForStageChange(person, newStage) {
  const stageLabel = labelForStage(newStage);
  const msg = `Stage set to: ${stageLabel}.`;
  try {
    const m = loadNotesMap();
    const arr = m[person.id] || [];
    arr.push({ id: crypto.randomUUID(), body: msg, auto: true, pinned: false, created_at: nowIso() });
    m[person.id] = arr;
    saveNotesMap(m);
  } catch {}
}
