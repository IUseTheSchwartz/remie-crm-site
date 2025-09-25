// File: src/components/ClickToCall.jsx
import { useEffect, useRef, useState, useCallback } from "react";
import { Phone, PhoneOff, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { supabase } from "../lib/supabaseClient.js";

// If your Dialer page already bundles @telnyx/webrtc, this will reuse it.
// If not, we import here (tree-shakes fine in Vite).
import { TelnyxRTC } from "@telnyx/webrtc";

/**
 * ✅ How this works
 * - If Dialer page has already created a Telnyx client, we reuse window.__telnyxClient.
 * - If not, we create it once and stash it globally so both pages share it.
 * - This ensures the Leads page behaves exactly like the Dialer page wrt audio.
 */

async function fetchSipCreds() {
  // Reuse signed-in user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  // Same tiny server function the Dialer page would use.
  // If yours is named differently, just change this URL.
  const resp = await fetch("/.netlify/functions/get-sip-creds", {
    headers: { "x-user-id": user.id },
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "Failed to load SIP creds");
  return json; // { sip_username, sip_password, caller_id }
}

async function ensureSharedClient() {
  if (window.__telnyxClient && window.__telnyxReady) return window.__telnyxClient;

  const { sip_username, sip_password } = await fetchSipCreds();

  // pre-warm mic (helps autoplay permissions)
  await navigator.mediaDevices.getUserMedia({ audio: true });

  const client = new TelnyxRTC({
    login: sip_username,
    password: sip_password,
    // debug: true,
  });

  await new Promise((resolve, reject) => {
    const onReady = () => {
      window.__telnyxClient = client;
      window.__telnyxReady = true;
      client.off("telnyx.ready", onReady);
      client.off("telnyx.error", onError);
      resolve();
    };
    const onError = (e) => {
      client.off("telnyx.ready", onReady);
      client.off("telnyx.error", onError);
      reject(new Error(e?.cause || "TelnyxRTC register failed"));
    };
    client.on("telnyx.ready", onReady);
    client.on("telnyx.error", onError);
    client.connect();
  });

  return client;
}

export default function ClickToCall({ toNumber, callerIdOverride, className }) {
  const [status, setStatus] = useState("idle"); // idle | dialing | active | ended | error
  const [muted, setMuted] = useState(false);
  const [deaf, setDeaf] = useState(false);
  const [err, setErr] = useState("");
  const remoteAudioRef = useRef(null);
  const localAudioRef = useRef(null);
  const currentCallRef = useRef(null);
  const [callerId, setCallerId] = useState(null);

  // load default caller ID once
  useEffect(() => {
    (async () => {
      try {
        const creds = await fetchSipCreds();
        setCallerId(callerIdOverride || creds.caller_id || null);
      } catch (e) {
        // don't block; we can still dial without explicit caller ID
        console.warn("SIP creds fetch warning:", e);
      }
    })();
  }, [callerIdOverride]);

  const startCall = useCallback(async () => {
    try {
      setErr("");
      setStatus("dialing");

      // ✅ Reuse existing Telnyx client from Dialer page if present
      const client =
        (window.__telnyxClient && window.__telnyxReady && window.__telnyxClient) ||
        (await ensureSharedClient());

      // ensure audio elements are ready
      if (remoteAudioRef.current) {
        remoteAudioRef.current.autoplay = true;
        remoteAudioRef.current.playsInline = true;
        remoteAudioRef.current.muted = false;
      }
      if (localAudioRef.current) {
        localAudioRef.current.autoplay = true;
        localAudioRef.current.playsInline = true;
        localAudioRef.current.muted = true; // avoid echo
      }

      const call = client.newCall({
        destinationNumber: toNumber,           // E.164
        callerNumber: callerId || undefined,   // your Telnyx DID
        audio: { micId: null, speakerId: null }
      });
      currentCallRef.current = call;

      call.on("stateChanged", (state) => {
        if (state === "ringing") setStatus("dialing");
        if (state === "active") setStatus("active");
        if (state === "hangup" || state === "destroy") setStatus("ended");
        if (state === "error") {
          setErr("Call failed");
          setStatus("error");
        }
      });

      call.on("remoteStreamAdded", (ev) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = ev.stream;
          remoteAudioRef.current.play().catch(() => {});
        }
      });
      call.on("localStreamAdded", (ev) => {
        if (localAudioRef.current) {
          localAudioRef.current.srcObject = ev.stream;
          localAudioRef.current.play().catch(() => {});
        }
      });

      // Outbound flow transitions to active on answer
      await call.answer();

    } catch (e) {
      console.error(e);
      setErr(e.message || "Dial error");
      setStatus("error");
    }
  }, [toNumber, callerId]);

  const hangup = useCallback(() => {
    try { currentCallRef.current?.hangup(); } catch {}
    setStatus("ended");
  }, []);

  const toggleMute = useCallback(() => {
    const call = currentCallRef.current;
    if (!call) return;
    if (muted) { call.unmuteAudio(); } else { call.muteAudio(); }
    setMuted(!muted);
  }, [muted]);

  const toggleDeaf = useCallback(() => {
    if (!remoteAudioRef.current) return;
    remoteAudioRef.current.muted = !deaf;
    setDeaf(!deaf);
  }, [deaf]);

  return (
    <div className={className || ""}>
      {/* hidden audio elements that actually carry the media */}
      <audio ref={remoteAudioRef} style={{ display: "none" }} />
      <audio ref={localAudioRef} style={{ display: "none" }} />

      {(status === "idle" || status === "ended" || status === "error") && (
        <button
          onClick={startCall}
          className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-emerald-600 text-white hover:bg-emerald-700"
          title="Call"
        >
          <Phone size={16} /> Call
        </button>
      )}

      {status === "dialing" && (
        <div className="inline-flex items-center gap-2 text-amber-600">Dialing…</div>
      )}

      {status === "active" && (
        <div className="inline-flex items-center gap-2">
          <button
            onClick={toggleMute}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-slate-200 hover:bg-slate-300"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            onClick={toggleDeaf}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-slate-200 hover:bg-slate-300"
            title={deaf ? "Enable speaker" : "Mute speaker"}
          >
            {deaf ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            onClick={hangup}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-rose-600 text-white hover:bg-rose-700"
            title="Hang up"
          >
            <PhoneOff size={16} /> Hang up
          </button>
        </div>
      )}

      {err ? <div className="mt-1 text-xs text-rose-600">{err}</div> : null}
    </div>
  );
}

/** Convenience wrapper you’re already using on LeadsPage */
export function PhoneLink({ number, callerId }) {
  return <ClickToCall toNumber={number} callerIdOverride={callerId} />;
}
