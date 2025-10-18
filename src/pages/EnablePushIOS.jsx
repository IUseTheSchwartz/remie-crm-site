// File: src/pages/EnablePushIOS.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// base64url -> Uint8Array
function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [isStandalone, setIsStandalone] = useState(false);

  const addLog = (m) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 120));

  useEffect(() => {
    const media = window.matchMedia?.("(display-mode: standalone)");
    setIsStandalone((media && media.matches) || window.navigator.standalone === true);

    if ("serviceWorker" in navigator) {
      if (navigator.serviceWorker.controller) {
        addLog("SW is controlling this page ✅");
      } else {
        addLog("No SW controller yet (first run)");
      }
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        addLog("controllerchange — new SW took control (iOS may reload once)");
      });
    }

    // Catch hard runtime errors to avoid “white screen without info”
    window.addEventListener("error", (e) => addLog(`window.onerror: ${e.message}`));
    window.addEventListener("unhandledrejection", (e) =>
      addLog(`unhandledrejection: ${e.reason?.message || String(e.reason)}`)
    );
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("Service Workers not supported");

    // Reuse existing registration if present; do not call reg.update() to avoid extra reloads
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      addLog("Registering /sw.js …");
      reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      addLog("Registered /sw.js");
    } else {
      addLog("Using existing SW registration");
    }

    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
  }

  async function enablePush() {
    // 1) Must be logged in inside the PWA context
    const { data: sess } = await supabase.auth.getSession();
    const jwt = sess?.session?.access_token || null;
    addLog(`Supabase session present: ${jwt ? "yes" : "no"}`);
    if (!jwt) {
      addLog("Please log in inside the installed app first (open /login in the PWA).");
      throw new Error("Not logged in");
    }

    // 2) Ask permission
    const perm = await Notification.requestPermission();
    setPermission(perm);
    addLog(`Notification.requestPermission() → ${perm}`);
    if (perm !== "granted") throw new Error("Permission not granted");

    // 3) Ensure SW
    const reg = await ensureSW();

    // 4) Subscribe or reuse
    const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!vapid) throw new Error("Missing VITE_VAPID_PUBLIC_KEY env");
    const appServerKey = urlB64ToUint8Array(vapid);

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      addLog("Subscribing to push …");
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      addLog("Push subscribed ✅");
    } else {
      addLog("Reusing existing push subscription");
    }

    // 5) Save subscription — ALWAYS include JWT in body (PWA often drops Authorization header)
    const body = {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys,
      platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
      topics: ["leads", "messages"],
      jwt, // <— important
    };

    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no Authorization header needed
      body: JSON.stringify(body),
    });
    addLog(`push-subscribe → ${res.status}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error || `push-subscribe failed ${res.status}`);
    }

    addLog("Subscription saved on server ✅");
  }

  async function sendTest() {
    // test sender: will try with Authorization (if present) but server usually doesn’t require it for test=1
    const { data: sess } = await supabase.auth.getSession();
    const jwt = sess?.session?.access_token || null;

    const res = await fetch("/.netlify/functions/_push?test=1", {
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    });
    addLog(`_push?test=1 → ${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || "test failed");
    addLog(`test result: ${JSON.stringify(j)}`);
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications on iOS</h1>
      <p className="text-sm text-white/70 mb-3">
        If you see a one-time refresh after the first tap, that’s normal — the service worker took control.
        After it reloads, tap the button again.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-2"
          onClick={() => enablePush().catch((e) => addLog(e.message || String(e)))}
        >
          Enable Notifications
        </button>

        <button
          type="button"
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-2"
          onClick={() => sendTest().catch((e) => addLog(e.message || String(e)))}
        >
          Send Test Push
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1">
        <div>VAPID key present: {import.meta.env.VITE_VAPID_PUBLIC_KEY ? "yes" : "no"}</div>
        <div>Notification permission: {permission}</div>
        <div>Display mode: {isStandalone ? "standalone" : "browser tab"}</div>
        <pre className="mt-2 whitespace-pre-wrap text-xs opacity-90">
          {log.map((l) => `• ${l}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}