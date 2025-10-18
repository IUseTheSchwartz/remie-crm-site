// File: src/pages/EnablePushIOS.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getAuthStuff() {
  const [{ data: userData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);
  const userId = userData?.user?.id || null;
  let jwt = sessionData?.session?.access_token || null;

  // best-effort refresh
  if (!jwt) {
    try {
      const { data: refreshed } = await supabase.auth.refreshSession();
      jwt = refreshed?.session?.access_token || jwt;
    } catch {}
  }

  return { userId, jwt };
}

export default function EnablePushIOS() {
  const [log, setLog] = useState<string[]>([]);
  const [permission, setPermission] = useState(Notification.permission);
  const [isStandalone, setIsStandalone] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const addLog = (m: string) => setLog((l) => [`${m}`, ...l].slice(0, 80));

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(media.matches || (window as any).navigator?.standalone === true);

    (async () => {
      const { userId } = await getAuthStuff();
      setUserId(userId || null);
      addLog(`Client user id: ${userId || "—"}`);
    })();
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("SW not supported");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
    // NOTE: make sure sw.js is at /public/sw.js and served at /sw.js
  }

  async function enableNotifications() {
    const { userId, jwt } = await getAuthStuff();
    if (!userId) {
      addLog("No Supabase user — make sure you’re logged in.");
      throw new Error("Not logged in");
    }
    addLog(`Using user ${userId.slice(0, 6)}…`);

    const perm = await Notification.requestPermission();
    setPermission(perm);
    addLog(`Notification.requestPermission(): ${perm}`);
    if (perm !== "granted") throw new Error("Permission not granted");

    const reg = await ensureSW();

    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!key) throw new Error("Missing VITE_VAPID_PUBLIC_KEY");
    const appServerKey = urlB64ToUint8Array(key);

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });

    addLog("Subscribed ✅");

    // Send to server — include BOTH Bearer header and body fallbacks
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (jwt) headers.Authorization = `Bearer ${jwt}`;

    const body = {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys, // { p256dh, auth }
      platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
      topics: ["leads", "messages"],

      // critical fallbacks
      user_id: userId,
      jwt,
    };

    addLog(`Sending subscribe with header: ${jwt ? "Bearer present" : "no header"} and body user_id`);

    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const txt = await res.text().catch(() => "");
    addLog(`push-subscribe → ${res.status} ${txt ? `(${txt.slice(0, 140)}…)` : ""}`);
    if (!res.ok) throw new Error(`push-subscribe failed ${res.status}`);
  }

  async function sendTest() {
    const { jwt } = await getAuthStuff();
    const headers: Record<string, string> = {};
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    const res = await fetch("/.netlify/functions/_push?test=1", { headers });
    addLog(`_push?test=1 → ${res.status}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || "test failed");
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications on iOS</h1>

      <div className="mb-3 text-sm text-white/80">
        Make sure you’re logged in, added to Home Screen, then tap the steps below.
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={ensureSW}>
          1) Register Service Worker
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={enableNotifications}>
          2) Enable Notifications
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={sendTest}>
          3) Send Test Push
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1">
        <div>VAPID key present: {import.meta.env.VITE_VAPID_PUBLIC_KEY ? "yes" : "no"}</div>
        <div>Notification permission: {permission}</div>
        <div>Display mode: {isStandalone ? "standalone" : "browser tab"}</div>
        <div>User ID (client): {userId || "—"}</div>
        <pre className="mt-2 whitespace-pre-wrap text-xs opacity-90">
          {log.map((l, i) => `• ${l}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}
