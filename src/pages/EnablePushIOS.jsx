// File: src/pages/EnablePushIOS.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(Notification.permission);
  const [isStandalone, setIsStandalone] = useState(false);

  const addLog = (m) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 80));

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(media.matches || window.navigator.standalone === true);

    // Helpful diagnostics around SW control + reload expectation
    if ("serviceWorker" in navigator) {
      if (navigator.serviceWorker.controller) {
        addLog("Service worker is already controlling this page ✅");
      } else {
        addLog("No service worker controller yet (first run)");
      }

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        addLog("controllerchange fired — a new SW took control (Safari may reload once)");
      });
    }
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("Service Workers not supported on this device");

    // Reuse existing registration if present to avoid churn/reloads
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      addLog("Registering /sw.js …");
      reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    } else {
      addLog("Existing SW registration found");
      // Proactively check for updates, but don’t force reloads here
      try {
        await reg.update();
        addLog("Checked for SW updates");
      } catch {}
    }

    await navigator.serviceWorker.ready;
    addLog("Service worker ready ✅");
    return reg;
  }

  async function enableNotifications(e) {
    e?.preventDefault?.();

    const perm = await Notification.requestPermission();
    setPermission(perm);
    addLog(`Notification.requestPermission(): ${perm}`);
    if (perm !== "granted") throw new Error("Permission not granted");

    const reg = await ensureSW();

    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!key) throw new Error("Missing VITE_VAPID_PUBLIC_KEY (check Netlify env)");

    const appServerKey = urlB64ToUint8Array(key);

    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      addLog("Already subscribed to push (reusing current subscription)");
      await saveSubscription(existing);
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });

    addLog("Push subscribed ✅");
    await saveSubscription(sub);
  }

  async function saveSubscription(sub) {
    const headers = {
      "Content-Type": "application/json",
      ...(await authHeader()),
    };
    const body = {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys,
      platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
      topics: ["leads", "messages"],
    };

    addLog("Sending subscription to server …");
    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    addLog(`push-subscribe → ${res.status}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error || `push-subscribe failed ${res.status}`);
    }
  }

  async function sendTest(e) {
    e?.preventDefault?.();
    const headers = await authHeader();
    const res = await fetch("/.netlify/functions/_push?test=1", { headers });
    addLog(`_push?test=1 → ${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || "test failed");
    addLog(`test result: ${JSON.stringify(j)}`);
  }

  async function registerSWClick(e) {
    e?.preventDefault?.();
    try {
      await ensureSW();
    } catch (err) {
      addLog(`SW error: ${err.message || err}`);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications on iOS</h1>
      <p className="text-sm text-white/70 mb-3">
        If the screen refreshes once on the first click, that’s normal — the new service worker takes control.
        After it reloads, tap “Enable Notifications”.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={registerSWClick}>
          1) Register SW
        </button>
        <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={enableNotifications}>
          2) Enable Notifications
        </button>
        <button type="button" className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={sendTest}>
          3) Send Test Push
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1">
        <div>VAPID key present: {import.meta.env.VITE_VAPID_PUBLIC_KEY ? "yes" : "no"}</div>
        <div>Notification permission: {permission}</div>
        <div>Display mode: {isStandalone ? "standalone" : "browser tab"}</div>
        <pre className="mt-2 whitespace-pre-wrap text-xs opacity-90">
          {log.map((l, i) => `• ${l}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}