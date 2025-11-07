// File: src/pages/EnablePushIOS.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js"; // ensure .js for ESM builds

const VERSION = "push-ios-v3.6"; // JS-only; fixes build error

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
  // Safe UA checks
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  const isStandalone =
    (typeof window !== "undefined" &&
      window.matchMedia?.("(display-mode: standalone)")?.matches) ||
    (typeof navigator !== "undefined" &&
      // iOS Safari exposes navigator.standalone when launched from Home Screen
      // guard to avoid build errors in non-iOS envs
      Object.prototype.hasOwnProperty.call(navigator, "standalone") &&
      navigator.standalone === true) ||
    false;

  const [busy, setBusy] = useState(false);
  const resuming = useRef(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
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
    if (!reg) {
      reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      await navigator.serviceWorker.ready;
    }
    return reg;
  }

  async function getJwt() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function finishSubscription() {
    const jwt = await getJwt();
    if (!jwt) throw new Error("Please log in on this device first.");

    if (typeof Notification === "undefined") throw new Error("Notifications unsupported here");
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Permission not granted");
    }

    const reg = await ensureSW();

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
    setBusy(true);
    try {
      if (!navigator.serviceWorker?.controller) {
        localStorage.setItem(FLOW_KEY, "pending");
      }
      await finishSubscription();
      alert("Notifications enabled ✅");
    } catch (e) {
      alert((e && e.message) || "Enable failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data?.session?.access_token || null;
      const res = await fetch("/.netlify/functions/push-test", {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Test failed");
      alert("Test notification sent ✅");
    } catch (e) {
      alert((e && e.message) || "Test failed");
    } finally {
      setBusy(false);
    }
  }

  // Gating states
  const notIOS = !isIOS;
  const wrongBrowser = isIOS && !isSafari;
  const needsA2HS = isIOS && isSafari && !isStandalone;
  const canEnable = isIOS && isSafari && isStandalone;

  return (
    <div className="p-6 max-w-md mx-auto text-white">
      <h1 className="text-xl font-semibold mb-2">Enable Notifications (iOS)</h1>
      <p className="text-xs text-white/60 mb-6">
        Version: <span className="font-mono">{VERSION}</span>
      </p>

      {notIOS && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          This setup must be done from an <b>iOS device</b> (iPhone/iPad) using <b>Safari</b>.
        </div>
      )}

      {wrongBrowser && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          You’re on iOS but not using Safari. Please open this page in <b>Safari</b>.
        </div>
      )}

      {needsA2HS && (
        <div className="rounded-2xl border border-blue-500/40 bg-blue-500/10 p-4 text-sm space-y-2">
          <div className="font-medium">Add Remie to your Home Screen first</div>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Tap the <b>Share</b> icon in Safari (square with arrow).</li>
            <li>Scroll and choose <b>Add to Home Screen</b>.</li>
            <li>Open Remie from your new Home Screen icon.</li>
            <li>Come back to this page in the app and tap <b>Enable Notifications</b>.</li>
          </ol>
          <div className="text-xs text-white/60">
            Apple only allows web push when the app is opened from the Home Screen.
          </div>
        </div>
      )}

      <div className="grid gap-2 mt-4">
        <button
          type="button"
          onClick={startFlow}
          disabled={!canEnable || busy}
          className={`rounded-xl px-4 py-2 text-sm font-medium ${
            canEnable ? "bg-white text-black hover:bg-white/90" : "bg-white/10 text-white/60 cursor-not-allowed"
          }`}
        >
          Enable Notifications
        </button>

        <button
          type="button"
          onClick={sendTest}
          disabled={!canEnable || busy}
          className={`rounded-xl px-4 py-2 text-sm ${
            canEnable
              ? "border border-white/15 bg-white/5 hover:bg-white/10"
              : "border border-white/10 bg-white/5 text-white/60 cursor-not-allowed"
          }`}
        >
          Test Notification
        </button>
      </div>
    </div>
  );
}
