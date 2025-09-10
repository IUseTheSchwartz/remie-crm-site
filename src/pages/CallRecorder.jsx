// File: src/pages/CallRecorder.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";
import {
  Mic,
  StopCircle,
  Download,
  FileText,
  AlertTriangle,
  Check,
  Search,
  Loader2,
  Trash2,
} from "lucide-react";

/* ---------------- Utilities ---------------- */

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "00:00";
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-");
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/* ---------------- Lightweight local "annotations" ---------------- */
function annotateTranscript(t) {
  if (!t?.trim()) return "No transcript captured.";
  const lines = t
    .replace(/\s+/g, " ")
    .split(/[.?!]\s/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kw = (k) => lines.filter((l) => new RegExp(`\\b${k}\\b`, "i").test(l));

  const phones = [
    ...new Set(
      t.match(/(\+?1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g) || []
    ),
  ];
  const emails = [...new Set(t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  const money = kw("(premium|price|dollar|payment|monthly|budget)");
  const appt = kw("(appointment|meet|call back|tomorrow|today|next week|schedule|calendar|time)");
  const needs = kw("(coverage|beneficiary|policy|term|whole life|final expense|i\\s*ul|index)");
  const obj = kw("(concern|worry|not sure|too expensive|think about|hesitant)");
  const actions = kw("(send|email you|text you|apply|application|submit|docs|id|pay stub|bank)");

  const bullet = (label, arr) =>
    arr?.length ? `- **${label}:**\n${arr.map((x) => `  • ${x}`).join("\n")}` : "";

  return [
    "### Summary (Local)",
    bullet("Contact Details", [
      phones.length ? `Phone: ${phones.join(", ")}` : null,
      emails.length ? `Email: ${emails.join(", ")}` : null,
    ].filter(Boolean)),
    bullet("Needs / Product Mentions", needs),
    bullet("Pricing / Budget", money),
    bullet("Objections / Concerns", obj),
    bullet("Appointments / Timing", appt),
    bullet("Action Items / Next Steps", actions),
  ].filter(Boolean).join("\n\n");
}

/* ---------------- IndexedDB (free local persistence) ---------------- */

const DB_NAME = "remie-recorder";
const STORE_RECS = "recordings";
const STORE_KV = "kv";
const DRAFT_KEY = "last-draft-id";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECS)) {
        const s = db.createObjectStore(STORE_RECS, { keyPath: "id", autoIncrement: true });
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutRec(obj) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECS, "readwrite");
    const req = tx.objectStore(STORE_RECS).put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetRec(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECS, "readonly");
    const req = tx.objectStore(STORE_RECS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelRec(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECS, "readwrite");
    const req = tx.objectStore(STORE_RECS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbSetKV(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, "readwrite");
    const req = tx.objectStore(STORE_KV).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbGetKV(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, "readonly");
    const req = tx.objectStore(STORE_KV).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Main Page ---------------- */

export default function CallRecorder() {
  const { user } = useAuth();

  // Recording state
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mimeType, setMimeType] = useState("");
  const [audioURL, setAudioURL] = useState("");
  const [blobSize, setBlobSize] = useState(0);
  const [error, setError] = useState("");

  // Media/Web Speech
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const timerRef = useRef(null);
  const chunksRef = useRef([]);
  const audioElRef = useRef(null);

  // Live transcript (local only)
  const SpeechRecognition =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const sttSupported = !!SpeechRecognition;
  const [autoNotesEnabled, setAutoNotesEnabled] = useState(!!SpeechRecognition);
  const recognitionRef = useRef(null);
  const [transcript, setTranscript] = useState("");
  const interimRef = useRef("");

  // Annotation output
  const [annotations, setAnnotations] = useState("");
  const [annotating, setAnnotating] = useState(false);

  // Lead selection
  const [leads, setLeads] = useState([]);
  const [leadSearch, setLeadSearch] = useState("");
  const [leadId, setLeadId] = useState(null);
  const [leadsLoading, setLeadsLoading] = useState(false);

  // Local persistence
  const draftIdRef = useRef(null);
  const saveDebounceRef = useRef(null);

  // Derived
  const selectedLead = useMemo(
    () => leads.find((l) => l.id === leadId) || null,
    [leadId, leads]
  );

  const filteredLeads = useMemo(() => {
    const q = leadSearch.trim().toLowerCase();
    if (!q) return leads.slice(0, 30);
    return leads.filter((l) => {
      const name = (l.name || "").toLowerCase();
      return (
        name.includes(q) ||
        (l.phone || "").toLowerCase().includes(q) ||
        (l.email || "").toLowerCase().includes(q)
      );
    });
  }, [leads, leadSearch]);

  /* -------- Fetch leads on mount (only mine) -------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id) return;
      setLeadsLoading(true);
      setError("");
      try {
        const { data, error: err } = await supabase
          .from("leads")
          .select("id, name, phone, email, stage")
          .or(`user_id.eq.${user.id},owner_user_id.eq.${user.id}`)
          .order("updated_at", { ascending: false })
          .limit(500);

        if (err) throw err;
        if (!cancelled) setLeads(data || []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load leads.");
      } finally {
        if (!cancelled) setLeadsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  /* -------- Restore last draft from IndexedDB on mount -------- */
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const draftId = await idbGetKV(DRAFT_KEY);
        if (!active || !draftId) return;
        const rec = await idbGetRec(draftId);
        if (!active || !rec) return;

        const url = URL.createObjectURL(rec.blob);
        if (!active) return;
        draftIdRef.current = rec.id;
        setAudioURL(url);
        setBlobSize(rec.blob.size || 0);
        setMimeType(rec.mimeType || "");
        setDuration(rec.duration || 0);
        setStopped(true);
        setTranscript(rec.transcript || "");
        setAnnotations(rec.annotations || "");
        setLeadId(rec.leadId || null);

        if (navigator?.storage?.persist) {
          try { await navigator.storage.persist(); } catch {}
        }
      } catch {
        // ignore restore errors
      }
    })();
    return () => { active = false; };
  }, []);

  /* -------- Clean up on unmount: stop mic/STT but DON'T clear audio -------- */
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
        recognitionRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try { mediaRecorderRef.current.stop(); } catch {}
        mediaRecorderRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  /* -------- Auto-save draft (debounced) whenever key fields change -------- */
  useEffect(() => {
    if (!audioURL) return;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => { saveDraft().catch(()=>{}); }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioURL, transcript, annotations, leadId, mimeType, duration, blobSize]);

  async function saveDraft() {
    try {
      if (!lastBlobRef.current) return;
      const obj = {
        id: draftIdRef.current || undefined,
        createdAt: Date.now(),
        mimeType,
        duration,
        leadId: leadId || null,
        leadName: selectedLead?.name || null,
        transcript,
        annotations,
        blob: lastBlobRef.current,
      };
      const newId = await idbPutRec(obj);
      draftIdRef.current = newId;
      await idbSetKV(DRAFT_KEY, newId);
    } catch {
      // ignore persistence errors
    }
  }

  const lastBlobRef = useRef(null);

  /* -------- Recording handlers -------- */
  async function startRecording() {
    setError("");
    setStopped(false);
    setAnnotations("");
    setTranscript("");
    interimRef.current = "";
    chunksRef.current = [];
    lastBlobRef.current = null;

    try {
      if (!consented) throw new Error("Please confirm you have consent to record.");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const prefer = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a",
        "audio/mp4",
        "audio/ogg;codecs=opus",
        "audio/ogg",
      ];
      const chosen = prefer.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
      setMimeType(chosen);

      const rec = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: chosen || "audio/webm" });
        lastBlobRef.current = blob;
        setBlobSize(blob.size);
        const url = URL.createObjectURL(blob);
        setAudioURL(url);
        setStopped(true);

        try {
          const a = new Audio();
          a.src = url;
          await new Promise((res, rej) => {
            a.onloadedmetadata = res;
            a.onerror = rej;
          });
          setDuration(a.duration || 0);
        } catch {}

        await saveDraft();
      };

      rec.start(1000);
      setRecording(true);

      let elapsed = 0;
      timerRef.current = setInterval(() => {
        elapsed += 1;
        setDuration(elapsed);
      }, 1000);

      if (autoNotesEnabled && SpeechRecognition) {
        const recog = new SpeechRecognition();
        recognitionRef.current = recog;
        recog.lang = "en-US";
        recog.continuous = true;
        recog.interimResults = true;
        recog.onresult = (ev) => {
          let finalText = "";
          let interimText = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) finalText += r[0].transcript + " ";
            else interimText += r[0].transcript + " ";
          }
          if (finalText) setTranscript((prev) => (prev + " " + finalText).trim());
          interimRef.current = interimText;
        };
        recog.onerror = () => {};
        recog.onend = () => {
          if (recording) {
            try { recog.start(); } catch {}
          }
        };
        try { recog.start(); } catch {}
      }
    } catch (e) {
      setError(e.message || "Failed to start recording.");
      stopEverything({ keepAudio: false });
    }
  }

  function stopEverything({ keepAudio = true } = {}) {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (recognitionRef.current) {
      try { recognitionRef.current.onresult = null; recognitionRef.current.onend = null; recognitionRef.current.onerror = null; recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setRecording(false);
    if (!keepAudio) {
      try { if (audioURL) URL.revokeObjectURL(audioURL); } catch {}
      setAudioURL("");
      setBlobSize(0);
      setDuration(0);
      setStopped(false);
      chunksRef.current = [];
      lastBlobRef.current = null;
      draftIdRef.current = null;
      idbSetKV(DRAFT_KEY, null).catch(()=>{});
    }
  }

  async function stopRecording() {
    try {
      const iv = (interimRef.current || "").trim();
      if (iv) setTranscript((prev) => (prev + " " + iv).trim());
    } catch {}
    stopEverything({ keepAudio: true });
    await saveDraft();
  }

  function handleAnnotate() {
    setAnnotating(true);
    try {
      const notes = annotateTranscript(transcript);
      setAnnotations(notes);
    } finally {
      setAnnotating(false);
    }
  }

  async function handleDeleteRecording() {
    const ok = typeof window !== "undefined" ? window.confirm("Delete this recording from your browser?") : true;
    if (!ok) return;
    try {
      if (draftIdRef.current) {
        await idbDelRec(draftIdRef.current);
        await idbSetKV(DRAFT_KEY, null);
      }
    } catch {}
    stopEverything({ keepAudio: false });
  }

  /* -------- UI -------- */
  return (
    <div className="max-w-5xl mx-auto p-6 text-white">
      <h1 className="text-2xl font-bold mb-2">Call Recorder (Local)</h1>
      <p className="text-white/70 mb-6">
        Records audio <span className="font-semibold">locally in your browser</span> (nothing is uploaded).
        Your latest recording is <span className="font-semibold">auto-saved</span> as a draft so it survives page changes and reloads.
      </p>

      <div className="flex items-start gap-3 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 mb-4">
        <AlertTriangle className="w-5 h-5 mt-0.5 text-yellow-400" />
        <div className="text-sm">
          <div className="font-medium">Legal reminder (not legal advice):</div>
          <div className="text-white/80">
            Recording calls may require consent depending on the state/country. Tennessee allows one-party consent, but
            interstate calls may require all-party consent. Confirm requirements and obtain consent before recording.
          </div>
          <label className="flex items-center gap-2 mt-2">
            <input
              type="checkbox"
              className="w-4 h-4 accent-emerald-500"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
            />
            <span>I confirm I have consent to record this call.</span>
          </label>
        </div>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="col-span-1 rounded-xl border border-white/10 p-4 bg-white/5">
          <div className="text-sm text-white/70 mb-2">Recorder</div>
          <div className="flex items-center gap-3">
            {!recording ? (
              <button
                onClick={startRecording}
                disabled={!consented}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium 
                  ${consented ? "bg-emerald-600 hover:bg-emerald-500" : "bg-emerald-900/40 cursor-not-allowed"}`}
                title={consented ? "Start recording" : "Consent required"}
              >
                <Mic className="w-4 h-4" />
                Start
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium bg-rose-600 hover:bg-rose-500"
                title="Stop recording"
              >
                <StopCircle className="w-4 h-4" />
                Stop
              </button>
            )}

            <div className="ml-auto text-right">
              <div className="text-xs uppercase tracking-wide text-white/60">Duration</div>
              <div className="text-lg font-mono">{fmtDuration(duration)}</div>
            </div>
          </div>

          <div className="mt-4 text-xs text-white/70">
            {recording ? (
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                Recording… {mimeType || "default"}
              </div>
            ) : stopped ? (
              <div>Ready. {mimeType ? mimeType : "audio/webm"} · {(blobSize / 1024 / 1024).toFixed(2)} MB</div>
            ) : (
              <div>Idle. {mimeType ? `Preferred: ${mimeType}` : ""}</div>
            )}
          </div>
        </div>

        <div className="col-span-1 rounded-xl border border-white/10 p-4 bg-white/5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-white/70">Live Transcript (Local)</div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="w-4 h-4 accent-emerald-500"
                checked={autoNotesEnabled}
                onChange={(e) => setAutoNotesEnabled(e.target.checked)}
                disabled={recording}
                title={sttSupported ? "" : "Speech recognition not supported in this browser"}
              />
              <span className={!sttSupported ? "line-through opacity-60" : ""}>
                Auto-capture
              </span>
            </label>
          </div>
          {!sttSupported && (
            <div className="text-xs text-white/60 mb-2">
              Your browser doesn’t support local speech recognition. You can still record audio and add manual notes.
            </div>
          )}
          <textarea
            className="w-full h-28 rounded-lg bg-black/30 border border-white/10 p-2 text-sm"
            placeholder="Transcript (captured locally while recording, or paste your notes here)…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
        </div>

        <div className="col-span-1 rounded-xl border border-white/10 p-4 bg-white/5">
          <div className="text-sm text-white/70 mb-2">Assign to Lead</div>
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-white/60" />
            <input
              className="flex-1 rounded-lg bg-black/30 border border-white/10 p-2 text-sm"
              placeholder="Search name, phone, or email…"
              value={leadSearch}
              onChange={(e) => setLeadSearch(e.target.value)}
            />
          </div>
          <div className="max-h-40 overflow-auto rounded-lg border border-white/10 divide-y divide-white/5">
            {leadsLoading ? (
              <div className="flex items-center gap-2 p-3 text-sm text-white/70">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading leads…
              </div>
            ) : filteredLeads.length ? (
              filteredLeads.map((l) => {
                const displayName = l.name || "Lead";
                return (
                  <button
                    key={l.id}
                    onClick={() => setLeadId(l.id)}
                    className={`w-full text-left p-2 text-sm hover:bg-white/10 ${
                      leadId === l.id ? "bg-emerald-600/20" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{displayName}</div>
                      <div className="text-xs text-white/60">{l.stage || "—"}</div>
                    </div>
                    <div className="text-xs text-white/60">
                      {l.phone || "—"} {l.email ? `· ${l.email}` : ""}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="p-3 text-sm text-white/60">No leads match your search.</div>
            )}
          </div>
          {selectedLead && (
            <div className="mt-2 text-xs text-emerald-300 flex items-center gap-1">
              <Check className="w-3 h-3" /> Linked to:{" "}
              <span className="font-medium">
                {selectedLead.name || "Lead"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Output / Download */}
      <div className="rounded-xl border border-white/10 p-4 bg-white/5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-white/70">Recording Output</div>
          <div className="flex items-center gap-2">
            {audioURL ? (
              <>
                <a
                  href={audioURL}
                  download={`call-${selectedLead ? slugify(selectedLead.name || "lead") : "unassigned"}-${nowStamp()}.${
                    (mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm"
                  }`}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500"
                >
                  <Download className="w-4 h-4" />
                  Download Audio
                </a>
                <button
                  onClick={handleDeleteRecording}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm bg-rose-700 hover:bg-rose-600"
                  title="Delete recording from this browser"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </div>

        {!audioURL && (
          <div className="text-sm text-white/60">
            Start recording to capture audio. When you stop, the player and a download button will appear here.
          </div>
        )}

        {audioURL && (
          <div className="space-y-3">
            <audio ref={audioElRef} src={audioURL} controls className="w-full" />
            <div className="text-xs text-white/60">
              Duration: {fmtDuration(duration)} · Size: {(blobSize / 1024 / 1024).toFixed(2)} MB ·{" "}
              {mimeType || "audio/webm"}
            </div>
          </div>
        )}
      </div>

      {/* Annotations */}
      <div className="rounded-xl border border-white/10 p-4 bg-white/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-white/70" />
            <div className="text-sm text-white/70">Annotations (local)</div>
          </div>
          <button
            onClick={handleAnnotate}
            disabled={annotating || !transcript.trim()}
            className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm 
              ${transcript.trim() ? "bg-purple-600 hover:bg-purple-500" : "bg-purple-900/40 cursor-not-allowed"}`}
            title={transcript.trim() ? "Generate notes from transcript" : "Transcript is empty"}
          >
            {annotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {annotating ? "Annotating…" : "Generate Annotations"}
          </button>
        </div>

        <textarea
          className="w-full h-52 rounded-lg bg-black/30 border border-white/10 p-3 text-sm font-mono"
          placeholder="Click ‘Generate Annotations’ to create notes from the transcript, or write your own here…"
          value={annotations}
          onChange={(e) => setAnnotations(e.target.value)}
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(annotations || ""); } catch {}
            }}
            className="rounded-xl px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20"
          >
            Copy Notes
          </button>
          <button
            onClick={() => {
              stopEverything({ keepAudio: true });
              setTranscript("");
              setAnnotations("");
              setLeadId(null);
              setLeadSearch("");
              setError("");
              saveDraft().catch(()=>{});
            }}
            className="rounded-xl px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20"
          >
            Reset Notes
          </button>
          <div className="ml-auto text-xs text-white/60">
            Notes/transcript stay in your browser unless you copy or download the audio.
          </div>
        </div>
      </div>

      {!!error && (
        <div className="mt-4 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-200 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
