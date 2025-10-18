// File: src/pages/EnablePushIOS.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const VERSION = "push-ios-v3.2"; // <-- bump this every change so you can see what’s live

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const FLOW_KEY = "remie:push:resume";
const last = (v) => (v ? new Date(v).toLocaleTimeString() : "—");

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );
  const [status, setStatus] = useState({
    hasController: false,
    regFound: false,
    subFound: false,
    jwtPresent: false,
    jwtTail: "",
    userId: "",
    userEmail: "",
    isStandalone:
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator.standalone === true ||
      false,
    lastReloadAt: localStorage.getItem("remie:push:lastReloadAt") || "",
  });
  const resuming = useRef(false);

  const addLog = (m) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 300));

  async function snapshot() {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    const { data: sess } = await supabase.auth.getSession();
    const { data: userData } = await supabase.auth.getUser();

    const jwt = sess?.session?.access_token || "";
    setStatus((s) => ({
      ...s,
      hasController: !!navigator.serviceWorker?.controller,
      regFound: !!reg,
      subFound: !!sub,
      jwtPresent: !!jwt,
      jwtTail: jwt ? jwt.slice(-8) : "",
      userId: userData?.user?.id || "",
      userEmail: userData?.user?.email || "",
    }));
  }

  useEffect(() => {
    snapshot();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        addLog("controllerchange — new SW took control (iOS may white-flash once)");
        localStorage.setItem("remie:push:lastReloadAt", String(Date.now()));
        setStatus((s) => ({ ...s, hasController: true }));
        if (localStorage.getItem(FLOW_KEY) === "pending" && !resuming.current) {
          resuming.current = true;
          setTimeout(() => finishSubscription().catch((e) => addLog(`resume fail: ${e.message}`)), 200);
        }
      });
    }

    window.addEventListener("error", (e) => addLog(`window.onerror: ${e.message}`));
    window.addEventListener("unhandledrejection", (e) =>
      addLog(`unhandledrejection: ${e.reason?.message || String(e.reason)}`)
    );
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("Service Workers not supported here");
    let reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      addLog("Using existing SW registration");
      return reg;
    }
    addLog("Registering /sw.js …");
    reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    if (reg.installing) {
      addLog("SW installing…");
      reg.installing.addEventListener("statechange", () => {
        addLog(`SW state: ${reg.installing?.state}`);
      });
    }
    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
  }

  async function getJwt() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function finishSubscription() {
    // 1) Must be logged in
    const jwt = await getJwt();
    addLog(`Supabase JWT present: ${jwt ? "yes" : "no"}`);
    if (!jwt) throw new Error("Not logged in inside the PWA. Open /login here and sign in.");

    // 2) Permission
    if (typeof Notification === "undefined") throw new Error("Notifications unsupported here");
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      addLog(`Notification.requestPermission() → ${perm}`);
      if (perm !== "granted") throw new Error("Permission not granted");
    } else {
      addLog("Permission already granted");
    }

    // 3) SW
    const reg = await ensureSW();

    // 4) Subscribe or reuse
    const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!VAPID) throw new Error("Missing VITE_VAPID_PUBLIC_KEY");
    const subExisting = await reg.pushManager.getSubscription();
    let sub = subExisting;
    if (!subExisting) {
      addLog("Subscribing to push …");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID),
      });
      addLog("Push subscribed ✅");
    } else {
      addLog("Reusing existing subscription");
    }

    // 5) Save to server — put JWT in body so iOS PWA doesn’t break us
    const payload = {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys,
      platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
      topics: ["leads", "messages"],
      jwt,
    };
    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    addLog(`push-subscribe → ${res.status}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error || `push-subscribe failed ${res.status}`);
    }
    localStorage.removeItem(FLOW_KEY);
    addLog("Subscription saved on server ✅");

    setStatus((s) => ({ ...s, regFound: true, subFound: true, jwtPresent: true, jwtTail: jwt.slice(-8) }));
  }

  async function startFlow() {
    try {
      if (!navigator.serviceWorker?.controller) {
        localStorage.setItem(FLOW_KEY, "pending");
        addLog("No SW controller yet — first run may hand control to SW (iOS may white-flash)");
      }
      await finishSubscription();
      await snapshot();
    } catch (e) {
      addLog(e.message || String(e));
    }
  }

  async function sendTest() {
    try {
      const jwt = await getJwt();
      const res = await fetch("/.netlify/functions/_push?test=1", {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      addLog(`_push?test=1 → ${res.status}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "test failed");
      addLog(`test result: ${JSON.stringify(j)}`);
    } catch (e) {
      addLog(e.message || String(e));
    }
  }

  async function unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        addLog("No SW registration to unsubscribe from");
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        addLog("Local push subscription removed");
      } else {
        addLog("No local subscription");
      }
      setStatus((s) => ({ ...s, subFound: false }));
    } catch (e) {
      addLog(e.message || String(e));
    }
  }

  async function refreshStatus() {
    await snapshot();
    addLog(
      `status → controller:${status.hasController} reg:${status.regFound} sub:${status.subFound} jwt:${status.jwtPresent}`
    );
  }

  async function echoAuth() {
    try {
      const jwt = await getJwt();
      const res = await fetch("/.netlify/functions/push-subscribe?echo=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jwt ? { jwt } : {}),
      });
      const j = await res.json().catch(() => ({}));
      addLog(`echo → ${res.status} ${JSON.stringify(j)}`);
    } catch (e) {
      addLog(`echo error: ${e.message}`);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications on iOS</h1>
      <p className="text-xs text-white/60 mb-1">Version: <span className="font-mono">{VERSION}</span></p>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1 mb-4">
        <div>User ID: <span className="font-mono">{status.userId || "—"}</span></div>
        <div>Email: {status.userEmail || "—"}</div>
        <div>JWT present: {status.jwtPresent ? `yes (…${status.jwtTail})` : "no"}</div>
        <div>SW controller: {status.hasController ? "yes" : "no"}</div>
        <div>SW registration: {status.regFound ? "found" : "none"}</div>
        <div>Push subscription: {status.subFound ? "found" : "none"}</div>
        <div>Display mode: {status.isStandalone ? "standalone" : "browser tab"}</div>
        <div>Last controller takeover: {last(status.lastReloadAt)}</div>
      </div>

      <div className="grid gap-2 mb-4">
        <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={startFlow}>
          Enable Notifications
        </button>

        <div className="flex gap-2 flex-wrap">
          <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={sendTest}>
            Send Test Push
          </button>
          <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={unsubscribe}>
            Unsubscribe (reset local)
          </button>
          <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={refreshStatus}>
            Refresh Status
          </button>
          <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={echoAuth}>
            Echo Auth
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
        <pre className="whitespace-pre-wrap text-xs opacity-90">{log.join("\n")}</pre>
      </div>
    </div>
  );
}