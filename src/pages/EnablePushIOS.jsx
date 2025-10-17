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

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function EnablePushIOS() {
  const [log, setLog] = useState([]);
  const [permission, setPermission] = useState(Notification.permission);
  const [isStandalone, setIsStandalone] = useState(false);

  const addLog = (m) => setLog((l) => [`${m}`, ...l].slice(0, 100));

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(media.matches || window.navigator.standalone === true);
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("SW not supported");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    addLog("SW ready ✅");
    return reg;
  }

  async function enableNotifications() {
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      addLog(`Notification.requestPermission(): ${perm}`);
      if (perm !== "granted") throw new Error("Permission not granted");

      const reg = await ensureSW();

      // Reuse existing subscription if one already exists
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        addLog("Already subscribed. ✅");
      } else {
        const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        if (!key) throw new Error("Missing VITE_VAPID_PUBLIC_KEY");
        const appServerKey = urlB64ToUint8Array(key);

        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        });
        addLog("Subscribed ✅");
      }

      const subJSON = sub.toJSON?.() || {};
      const headers = {
        "Content-Type": "application/json",
        ...(await authHeader()),
      };

      const res = await fetch("/.netlify/functions/push-subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: subJSON.keys || { p256dh: subJSON.p256dh, auth: subJSON.auth },
          platform: /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "ios" : "web",
          topics: ["leads", "messages"],
        }),
      });
      addLog(`push-subscribe → ${res.status}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`push-subscribe failed ${res.status}: ${j?.error || ""}`);
      }
    } catch (e) {
      addLog(`Subscribe error: ${e?.message || e}`);
      throw e;
    }
  }

  async function sendTest() {
    try {
      const headers = await authHeader();
      if (!headers.Authorization) {
        addLog("No session token (are you logged in?)");
        return;
      }
      const r = await fetch("/.netlify/functions/push-test", {
        method: "POST",
        headers,
      });
      addLog(`push-test → ${r.status}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        addLog(`push-test error: ${j?.error || "unknown"}`);
      } else {
        addLog(`push-test result: sent=${j?.sent ?? 0}, removed=${j?.removed ?? 0}`);
      }
    } catch (e) {
      addLog(`push-test fetch error: ${e?.message || e}`);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Push Debug</h1>
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
