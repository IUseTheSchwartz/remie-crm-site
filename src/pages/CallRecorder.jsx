// File: src/pages/CallRecorder.jsx
import { useEffect, useRef, useState } from "react";
import { Mic, Video, StopCircle, Download, Trash2, Loader2 } from "lucide-react";

/* ---------------- Utilities ---------------- */

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "00:00";
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
function fmtDateTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return "—"; }
}
function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-");
}

/* ---------------- IndexedDB (local persistence) ---------------- */

const DB_NAME = "remie-recorder";
const STORE_RECS = "recordings";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECS)) {
        const s = db.createObjectStore(STORE_RECS, { keyPath: "id", autoIncrement: true });
        s.createIndex("createdAt", "createdAt");
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
async function idbGetAllRecs() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECS, "readonly");
    const req = tx.objectStore(STORE_RECS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbUpdateRec(id, patch) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECS, "readwrite");
    const store = tx.objectStore(STORE_RECS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve(false);
      const putReq = store.put({ ...rec, ...patch });
      putReq.onsuccess = () => resolve(true);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
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

/* ---------------- Main Component ---------------- */

export default function CallRecorder() {
  const [error, setError] = useState("");
  const [recs, setRecs] = useState([]); // [{id, createdAt, mimeType, duration, transcript, blob, url, size, hasVideo}] + {isDraft:true}
  const [loadingRecs, setLoadingRecs] = useState(true);

  // In-progress recording
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mimeType, setMimeType] = useState("");
  const [autoSTT, setAutoSTT] = useState(true);
  const [recordVideo, setRecordVideo] = useState(false); // NEW: toggle camera

  // Media/STT refs
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const previewVideoRef = useRef(null); // NEW: live cam preview
  const timerRef = useRef(null);
  const chunksRef = useRef([]);
  const lastBlobRef = useRef(null);

  const SpeechRecognition =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const sttSupported = !!SpeechRecognition;
  const recognitionRef = useRef(null);
  const interimRef = useRef("");
  const sessionIdRef = useRef(0);
  const recordingRef = useRef(false);

  // The live transcript for the current draft (kept in a ref to avoid stale-closure saves)
  const draftTranscriptRef = useRef("");

  /* -------- Load existing recordings on mount -------- */
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const all = await idbGetAllRecs();
        const withUrls = all
          .map((r) => ({
            ...r,
            url: URL.createObjectURL(r.blob),
            size: r.blob?.size || 0,
          }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (active) setRecs(withUrls);
      } catch (e) {
        if (active) setError(e.message || "Failed to load recordings.");
      } finally {
        if (active) setLoadingRecs(false);
      }

      if (navigator?.storage?.persist) {
        try {
          await navigator.storage.persist();
        } catch {}
      }
    })();
    return () => {
      active = false;
      try {
        recs.forEach((r) => r.url && URL.revokeObjectURL(r.url));
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- Cleanup on unmount -------- */
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {}
      try {
        mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch {}
    };
  }, []);

  /* -------- Draft helpers -------- */
  function addDraftCard() {
    draftTranscriptRef.current = "";
    const draft = {
      id: "__draft__",
      isDraft: true,
      createdAt: Date.now(),
      mimeType: mimeType || (recordVideo ? "video/webm" : "audio/webm"),
      duration: 0,
      transcript: "",
      url: null,
      size: 0,
      hasVideo: !!recordVideo,
    };
    setRecs((prev) => [draft, ...prev.filter((r) => !r.isDraft)]);
  }
  function updateDraft(patch) {
    setRecs((prev) => prev.map((r) => (r.isDraft ? { ...r, ...patch } : r)));
  }
  function appendToDraftTranscript(text) {
    draftTranscriptRef.current = (draftTranscriptRef.current + " " + (text || "")).trim();
    setRecs((prev) =>
      prev.map((r) => (r.isDraft ? { ...r, transcript: draftTranscriptRef.current } : r))
    );
  }
  function replaceDraftWith(savedRec) {
    setRecs((prev) => {
      const withoutDraft = prev.filter((r) => !r.isDraft);
      return [savedRec, ...withoutDraft];
    });
    draftTranscriptRef.current = "";
  }
  function removeDraft() {
    setRecs((prev) => prev.filter((r) => !r.isDraft));
    draftTranscriptRef.current = "";
  }

  /* -------- MIME helpers -------- */
  function chooseMimeType(wantsVideo) {
    // Prefer the best the browser supports.
    const candidates = wantsVideo
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
          "video/mp4;codecs=avc1,mp4a", // Safari 16.4+ typically
          "video/mp4",
        ]
      : [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/mp4;codecs=mp4a",
          "audio/mp4",
          "audio/ogg;codecs=opus",
          "audio/ogg",
        ];
    const supported = candidates.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    return supported || (wantsVideo ? "video/webm" : "audio/webm");
  }

  /* -------- Start recording -------- */
  async function startRecording() {
    setError("");
    chunksRef.current = [];
    lastBlobRef.current = null;
    setDuration(0);
    removeDraft(); // in case a previous draft lingered

    try {
      const constraints = {
        audio: true,
        video: recordVideo
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            }
          : false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      const chosen = chooseMimeType(recordVideo);
      setMimeType(chosen);

      // Create draft immediately so live STT writes directly into it
      addDraftCard();

      // New session guard
      sessionIdRef.current += 1;
      const mySession = sessionIdRef.current;
      recordingRef.current = true;

      // Live preview if video
      if (recordVideo && previewVideoRef.current) {
        try {
          previewVideoRef.current.srcObject = stream;
          // Required for some browsers to start playing
          await previewVideoRef.current.play().catch(() => {});
        } catch {}
      }

      // MediaRecorder
      const rec = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        // Build final blob
        const blob = new Blob(chunksRef.current, {
          type: chosen || (recordVideo ? "video/webm" : "audio/webm"),
        });
        lastBlobRef.current = blob;

        // Duration (fallback to timer)
        let dur = duration;
        try {
          const mediaEl = document.createElement(recordVideo ? "video" : "audio");
          mediaEl.src = URL.createObjectURL(blob);
          await new Promise((res, rej) => {
            mediaEl.onloadedmetadata = res;
            mediaEl.onerror = rej;
          });
          if (Number.isFinite(mediaEl.duration)) dur = mediaEl.duration;
        } catch {}

        // Snapshot transcript from ref to avoid stale state
        const transcript = (draftTranscriptRef.current || "").trim();

        // Persist
        const payload = {
          createdAt: Date.now(),
          mimeType: chosen || (recordVideo ? "video/webm" : "audio/webm"),
          duration: dur,
          transcript,
          blob,
          hasVideo: !!recordVideo,
        };
        const id = await idbPutRec(payload);
        const url = URL.createObjectURL(blob);
        const saved = {
          id,
          createdAt: payload.createdAt,
          mimeType: payload.mimeType,
          duration: payload.duration,
          transcript,
          blob,
          url,
          size: blob.size || 0,
          hasVideo: payload.hasVideo,
        };

        replaceDraftWith(saved);
      };

      rec.start(1000);
      setRecording(true);

      // Timer
      let elapsed = 0;
      timerRef.current = setInterval(() => {
        elapsed += 1;
        setDuration(elapsed);
        updateDraft({ duration: elapsed });
      }, 1000);

      // Speech-to-Text bound to this draft (still works for video)
      if (autoSTT && sttSupported) {
        const recog = new SpeechRecognition();
        recognitionRef.current = recog;
        recog.lang = "en-US";
        recog.continuous = true;
        recog.interimResults = true;

        recog.onresult = (ev) => {
          if (sessionIdRef.current !== mySession) return; // guard
          let finalText = "";
          let interimText = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) finalText += r[0].transcript + " ";
            else interimText += r[0].transcript + " ";
          }
          if (finalText) appendToDraftTranscript(finalText);
          interimRef.current = interimText;
        };
        recog.onerror = () => {
          try { recog.stop(); } catch {}
        };
        recog.onend = () => {
          // auto-restart if still same session and still recording
          if (sessionIdRef.current === mySession && recordingRef.current) {
            try { recog.start(); } catch {}
          }
        };
        try { recog.start(); } catch {}
      }
    } catch (e) {
      setError(e.message || "Failed to start recording.");
      stopRecording(true);
    }
  }

  /* -------- Stop recording -------- */
  async function stopRecording(silent = false) {
    // Flush interim into draft ref/ UI
    try {
      const iv = (interimRef.current || "").trim();
      if (iv) appendToDraftTranscript(iv);
    } catch {}

    recordingRef.current = false;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      recognitionRef.current?.stop?.();
    } catch {}
    recognitionRef.current = null;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;

    try {
      // Stop all tracks (audio + video)
      mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    mediaStreamRef.current = null;

    // Clear preview
    if (previewVideoRef.current) {
      try {
        previewVideoRef.current.srcObject = null;
      } catch {}
    }

    setRecording(false);

    if (silent) {
      removeDraft();
      chunksRef.current = [];
      lastBlobRef.current = null;
    }
  }

  /* -------- Saved recording actions -------- */
  async function handleDeleteRecording(id) {
    const ok =
      typeof window !== "undefined"
        ? window.confirm("Delete this recording from your browser?")
        : true;
    if (!ok) return;
    try {
      await idbDelRec(id);
    } catch {}
    setRecs((prev) => {
      const removed = prev.find((r) => r.id === id);
      try {
        if (removed?.url) URL.revokeObjectURL(removed.url);
      } catch {}
      return prev.filter((r) => r.id !== id);
    });
  }

  async function handleUpdateTranscript(id, text) {
    try {
      await idbUpdateRec(id, { transcript: text });
      setRecs((prev) => prev.map((r) => (r.id === id ? { ...r, transcript: text } : r)));
    } catch {}
  }

  function downloadExtFor(mime) {
    const m = (mime || "").toLowerCase();
    if (m.includes("video/mp4")) return "mp4";
    if (m.startsWith("video/")) return "webm";
    if (m.includes("audio/mp4")) return "m4a";
    if (m.includes("audio/ogg")) return "ogg";
    return "webm";
  }

  /* -------- UI -------- */
  return (
    <div className="max-w-5xl mx-auto p-6 text-white">
      <h1 className="text-2xl font-bold mb-2">Call/Camera Recorder (Local)</h1>
      <p className="text-white/70 mb-6">
        Records <span className="font-semibold">locally in your browser</span> (no uploads).
        You can capture audio-only or include your camera. Live transcript is attached to the in-progress recording and saved with it on stop.
      </p>

      {/* Controls */}
      <div className="rounded-xl border border-white/10 p-4 bg-white/5 mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            {!recording ? (
              <button
                onClick={startRecording}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500"
                title="Start recording"
              >
                {recordVideo ? <Video className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                Start
              </button>
            ) : (
              <button
                onClick={() => stopRecording(false)}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium bg-rose-600 hover:bg-rose-500"
                title="Stop recording"
              >
                <StopCircle className="w-4 h-4" />
                Stop
              </button>
            )}

            <label className="ml-2 inline-flex items-center gap-2 text-sm text-white/80">
              <input
                type="checkbox"
                className="w-4 h-4 accent-indigo-500"
                checked={recordVideo}
                disabled={recording}
                onChange={(e) => setRecordVideo(e.target.checked)}
                title="Include camera video"
              />
              Record camera (video)
            </label>
          </div>

          <div className="sm:ml-auto sm:text-right">
            <div className="text-xs uppercase tracking-wide text-white/60">Duration</div>
            <div className="text-lg font-mono">{fmtDuration(duration)}</div>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:items-center text-xs text-white/70">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="w-4 h-4 accent-emerald-500"
              checked={autoSTT}
              onChange={(e) => setAutoSTT(e.target.checked)}
              disabled={!sttSupported || recording}
              title={sttSupported ? "" : "Speech recognition not supported in this browser"}
            />
            <span className={!sttSupported ? "line-through opacity-60" : ""}>
              Auto-capture transcript (local)
            </span>
          </label>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <span>Format: {mimeType || (recordVideo ? "video/webm" : "audio/webm")}</span>
          </div>
        </div>

        {/* Live camera preview */}
        {recording && recordVideo && (
          <div className="mt-4">
            <div className="text-xs text-white/60 mb-2">Live preview (camera)</div>
            <video
              ref={previewVideoRef}
              className="w-full rounded-lg border border-white/10 bg-black/30"
              muted
              playsInline
              autoPlay
            />
          </div>
        )}
      </div>

      {/* Recordings list */}
      <div className="rounded-xl border border-white/10 p-4 bg-white/5">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-sm text-white/70">Recordings</div>
          {loadingRecs && <Loader2 className="w-4 h-4 animate-spin text-white/60" />}
        </div>

        {!loadingRecs && !recs.length && (
          <div className="text-sm text-white/60">No recordings yet. Hit Start to capture your first one.</div>
        )}

        <div className="space-y-4">
          {recs.map((r) => (
            <div
              key={r.id}
              className={`rounded-lg border border-white/10 p-3 ${r.isDraft ? "bg-amber-500/10" : "bg-black/20"}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">
                    {r.isDraft ? "Recording in progress…" : `Recording #${r.id}`} • {fmtDateTime(r.createdAt)}
                  </div>
                  <div className="text-xs text-white/60">
                    {r.hasVideo ? "Video" : "Audio"} · Duration: {fmtDuration(r.duration)} ·{" "}
                    {r.isDraft ? "capturing…" : `Size: ${(r.size / 1024 / 1024).toFixed(2)} MB`} · {r.mimeType}
                  </div>
                </div>
                {!r.isDraft && (
                  <div className="flex items-center gap-2">
                    <a
                      href={r.url}
                      download={`recording-${nowStamp()}.${downloadExtFor(r.mimeType)}`}
                      className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </a>
                    <button
                      onClick={() => handleDeleteRecording(r.id)}
                      className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm bg-rose-700 hover:bg-rose-600"
                      title="Delete recording from this browser"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  </div>
                )}
              </div>

              {!r.isDraft && (
                <div className="mt-2">
                  {r.hasVideo ? (
                    <video src={r.url} controls className="w-full rounded-lg border border-white/10 bg-black/30" />
                  ) : (
                    <audio src={r.url} controls className="w-full" />
                  )}
                </div>
              )}

              <div className="mt-3">
                <div className="text-xs text-white/60 mb-1">
                  Transcript ({r.isDraft ? "live" : "saved"}) — stored with this recording
                </div>
                {r.isDraft ? (
                  <textarea
                    className="w-full h-28 rounded-lg bg-black/30 border border-white/10 p-2 text-sm"
                    placeholder="Live transcript will appear here…"
                    value={r.transcript || ""}
                    onChange={(e) => {
                      draftTranscriptRef.current = e.target.value;
                      updateDraft({ transcript: e.target.value });
                    }}
                  />
                ) : (
                  <textarea
                    className="w-full h-28 rounded-lg bg-black/30 border border-white/10 p-2 text-sm"
                    placeholder="Edit or add transcript notes for this recording…"
                    defaultValue={r.transcript || ""}
                    onBlur={(e) => handleUpdateTranscript(r.id, e.target.value)}
                  />
                )}
              </div>
            </div>
          ))}
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
