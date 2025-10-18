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

async function getSessionBits() {
  const { data } = await supabase.auth.getSession();
  const jwt = data?.session?.access_token || null;
  const uid = data?.session?.user?.id || null;
  return { jwt, uid };
}

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(Notification.permission);
  const [isStandalone, setIsStandalone] = useState(false);
  const [uid, setUid] = useState(null);

  const addLog = (m) => setLog((l) => [`${m}`, ...l].slice(0, 50));

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(media.matches || window.navigator.standalone === true);
    // show current user for debugging
    (async () => {
      const { uid } = await getSessionBits();
      setUid(uid);
    })();
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("SW not supported");
    // re-register to avoid stale
    const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
  }

  async function enableNotifications() {
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

    // include BOTH header + body fallbacks
    const { jwt, uid } = await getSessionBits();
    if (!uid) addLog("⚠️ No uid from session; are you logged in?");

    const headers = {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    };

    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
        topics: ["leads", "messages"],
        // 👇 body fallback for Netlify function
        user_id: uid || null,
        jwt: jwt || null,
      }),
    });
    addLog(`push-subscribe → ${res.status}`);
    if (!res.ok) {
      let j = {};
      try { j = await res.json(); } catch {}
      addLog(`push-subscribe error: ${j?.error || res.status}`);
      throw new Error(`push-subscribe failed ${res.status}`);
    } else {
      const j = await res.json().catch(() => ({}));
      addLog(`Server stored sub. sent=${j?.sent ?? "?"} removed=${j?.removed ?? "?"}`);
    }
  }

  async function sendTest() {
    const { jwt, uid } = await getSessionBits();
    const headers = {
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      "Content-Type": "application/json",
    };
    const res = await fetch("/.netlify/functions/_push?test=1", { headers });
    addLog(`push-test → ${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || "test failed");
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications on iOS</h1>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1 mb-4">
        <div>User: {uid || "not logged in"}</div>
        <div>VAPID key present: {import.meta.env.VITE_VAPID_PUBLIC_KEY ? "yes" : "no"}</div>
        <div>Notification permission: {permission}</div>
        <div>Display mode: {isStandalone ? "standalone (PWA)" : "browser tab"}</div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={ensureSW}>
          1) Register SW
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={enableNotifications}>
          2) Enable Notifications
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={sendTest}>
          3) Send Test Push
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
        <div className="mb-1 font-medium">Log</div>
        <pre className="whitespace-pre-wrap text-xs opacity-90">
          {log.map((l, i) => `• ${l}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}
