// File: src/pages/EnablePushIOS.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const VERSION = "push-ios-v3.4"; // trimmed UI + copy tweaks

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const FLOW_KEY = "remie:push:resume";

export default function EnablePushIOS() {
  const [permission, setPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );
  const [busy, setBusy] = useState(false);
  const resuming = useRef(false);

  // iOS device check (must be mobile iOS)
  const isIOSMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // iOS may white-flash when the SW takes control after first visit
        if (localStorage.getItem(FLOW_KEY) === "pending" && !resuming.current) {
          resuming.current = true;
          setTimeout(() => finishSubscription().catch(() => {}), 200);
        }
      });
    }
  }, []);

  async function ensureSW() {
    if (!("serviceWorker" in navigator)) throw new Error("Service Workers not supported here");
    let reg = await navigator.serviceWorker.getRegistration();
    if (reg) return reg;
    reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    return reg;
  }

  async function getJwt() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function finishSubscription() {
    // 1) Must be logged in
    const jwt = await getJwt();
    if (!jwt) throw new Error("Please log in on this device first.");

    // 2) Permission
    if (typeof Notification === "undefined") throw new Error("Notifications unsupported here");
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") throw new Error("Permission not granted");
    }

    // 3) SW
    const reg = await ensureSW();

    // 4) Subscribe or reuse
    const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!VAPID) throw new Error("Missing VITE_VAPID_PUBLIC_KEY");
    const subExisting = await reg.pushManager.getSubscription();
    let sub = subExisting;
    if (!subExisting) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID),
      });
    }

    // 5) Save to server
    const payload = {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys,
      platform: "ios",
      topics: ["leads", "messages"],
      jwt,
    };
    const res = await fetch("/.netlify/functions/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error || `push-subscribe failed ${res.status}`);
    }
    localStorage.removeItem(FLOW_KEY);
  }

  async function startFlow() {
    if (!isIOSMobile) return;
    setBusy(true);
    try {
      if (!navigator.serviceWorker?.controller) {
        localStorage.setItem(FLOW_KEY, "pending");
      }
      await finishSubscription();
      alert("Notifications enabled ✅");
    } catch (e) {
      alert(e.message || "Enable failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!isIOSMobile) return;
    setBusy(true);
    try {
      const jwt = await getJwt();
      const res = await fetch("/.netlify/functions/push-test", {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Test failed");
      alert("Test notification sent ✅");
    } catch (e) {
      alert(e.message || "Test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-md mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications (iOS)</h1>
      <p className="text-xs text-white/60 mb-6">
        Version: <span className="font-mono">{VERSION}</span>
      </p>

      {!isIOSMobile ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          This setup must be done from an <b>iOS device</b> (iPhone or iPad) using <b>Safari</b>.
          Open this page on your iPhone/iPad to continue.
        </div>
      ) : (
        <div className="grid gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={startFlow}
            className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-white/90 disabled:opacity-60"
          >
            Enable Notifications
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={sendTest}
            className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-60"
          >
            Test Notification
          </button>
        </div>
      )}
    </div>
  );
}
