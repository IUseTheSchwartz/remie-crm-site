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

async function getSession() {
  const { data } = await supabase.auth.getSession();
  const session = data?.session || null;
  const user = session?.user || null;
  const jwt = session?.access_token || "";
  return { user, jwt };
}

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(Notification.permission);
  const [isStandalone, setIsStandalone] = useState(false);
  const [user, setUser] = useState(null);
  const [jwt, setJwt] = useState("");

  const addLog = (m) => setLog((l) => [`${new Date().toLocaleTimeString()} — ${m}`, ...l].slice(0, 80));

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(media.matches || window.navigator.standalone === true);

    (async () => {
      const { user: u, jwt: j } = await getSession();
      setUser(u);
      setJwt(j);
      addLog(`Session: user=${u?.id ? u.id : "none"} jwt=${j ? "present" : "missing"}`);
    })();
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("Service Worker not supported");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
  }

  async function enableNotifications() {
    // Make sure we’re logged in (in the PWA storage)
    const { user: u, jwt: j } = await getSession();
    setUser(u);
    setJwt(j);
    if (!u || !j) {
      addLog("Not logged in in this context. Go to /login inside the PWA and sign in.");
      throw new Error("Not logged in");
    }

    const perm = await Notification.requestPermission();
    setPermission(perm);
    addLog(`Notification.requestPermission(): ${perm}`);
    if (perm !== "granted") throw new Error("Permission not granted");

    const reg = await ensureSW();

    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!key) {
      addLog("Missing VITE_VAPID_PUBLIC_KEY env");
      throw new Error("Missing VAPID public key");
    }
    const appServerKey = urlB64ToUint8Array(key);

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });

    addLog("PushManager.subscribe() → OK");

    // Send to server with BOTH header + body auth
    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // header auth (function will try this first)
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify({
        // body auth (function will fall back to this)
        jwt,
        user_id: u.id,
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
        topics: ["leads", "messages"],
      }),
    });

    addLog(`push-subscribe → ${res.status}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      addLog(`push-subscribe error: ${j?.error || res.status}`);
      throw new Error(j?.error || `push-subscribe failed ${res.status}`);
    } else {
      const j = await res.json().catch(() => ({}));
      addLog(`push-subscribe ok: ${JSON.stringify(j)}`);
    }
  }

  async function sendTest() {
    const { jwt: j } = await getSession();
    const res = await fetch("/.netlify/functions/_push?test=1", {
      headers: j ? { Authorization: `Bearer ${j}` } : {},
    });
    addLog(`_push?test=1 → ${res.status}`);
    const js = await res.json().catch(() => ({}));
    addLog(`_push?test=1 body: ${JSON.stringify(js)}`);
    if (!res.ok) throw new Error(js?.error || "test failed");
  }

  async function refreshSession() {
    const { user: u, jwt: j } = await getSession();
    setUser(u);
    setJwt(j);
    addLog(`Refreshed session → user=${u?.id || "none"} jwt=${j ? "present" : "missing"}`);
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white space-y-3">
      <h1 className="text-xl font-semibold">Enable Notifications on iOS</h1>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm space-y-1">
        <div>User: {user?.id || "not logged in"}</div>
        <div>JWT present: {jwt ? "yes" : "no"}</div>
        <div>Display mode: {isStandalone ? "standalone (PWA)" : "browser tab"}</div>
        <div>Notification permission: {permission}</div>
        <div>VAPID key present: {import.meta.env.VITE_VAPID_PUBLIC_KEY ? "yes" : "no"}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={ensureSW}>
          1) Register SW
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={enableNotifications}>
          2) Enable Notifications
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={sendTest}>
          3) Send Test Push
        </button>
        <button className="rounded-lg border border-white/15 bg-white/5 px-3 py-2" onClick={refreshSession}>
          Refresh Session
        </button>
      </div>

      <pre className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs whitespace-pre-wrap">
        {log.join("\n")}
      </pre>
    </div>
  );
}
