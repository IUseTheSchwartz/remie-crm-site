// src/lib/notifications.js
// Client-side helpers to (a) detect support, (b) register SW, (c) prompt + subscribe,
// and (d) save the subscription to your backend (Netlify function).

import { supabase } from "./supabaseClient";

// ---- tiny platform helpers ----
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isAndroid() {
  return /android/i.test(navigator.userAgent);
}
function isStandalone() {
  // iOS Safari PWA installed check + generic display-mode
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}
export function isPhonePlatform() {
  return isIOS() || isAndroid();
}

// ---- feature detection ----
export function pushSupportedOnThisDevice() {
  // Phones only (per your scope), plus required APIs
  if (!isPhonePlatform()) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("PushManager" in window)) return false;
  if (!("Notification" in window)) return false;

  // iOS requires the app to be installed to Home Screen
  if (isIOS() && !isStandalone()) return false;

  return true;
}

// ---- auth header for Netlify functions (optional but preferred) ----
async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

// ---- ensure SW registered (idempotent) ----
async function ensureServiceWorker() {
  try {
    // already controlled?
    if (navigator.serviceWorker.controller) {
      return navigator.serviceWorker.ready;
    }
    // register at the site root (Vite serves /public at /)
    await navigator.serviceWorker.register("/sw.js");
    return navigator.serviceWorker.ready;
  } catch (e) {
    console.warn("[notifications] SW register failed:", e?.message || e);
    throw e;
  }
}

// ---- request permission (must be called from a user gesture) ----
export async function requestPushPermission() {
  if (!pushSupportedOnThisDevice()) {
    return { granted: false, reason: "unsupported" };
  }
  try {
    const perm = await Notification.requestPermission();
    return { granted: perm === "granted", state: perm };
  } catch (e) {
    return { granted: false, reason: e?.message || "permission_error" };
  }
}

// ---- subscribe & persist on server ----
export async function subscribeForPush() {
  if (!pushSupportedOnThisDevice()) {
    throw new Error("Push not supported on this device");
  }

  const ready = await ensureServiceWorker();

  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("Missing VITE_VAPID_PUBLIC_KEY");

  // VAPID applicationServerKey expects a Uint8Array
  const appServerKey = urlBase64ToUint8Array(publicKey);

  const permission = Notification.permission;
  if (permission !== "granted") {
    throw new Error(`Permission not granted (${permission})`);
  }

  // Create (or reuse) a subscription
  const sub = await ready.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: appServerKey,
  });

  // Persist to backend
  const headers = await authHeaders();
  const res = await fetch("/.netlify/functions/push-subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      subscription: sub,                // full web push subscription
      userAgent: navigator.userAgent,   // handy for debugging/cleanup
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`push-subscribe failed (${res.status}): ${t}`);
  }

  return sub;
}

export async function unsubscribeFromPush() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try {
      await sub.unsubscribe();
    } catch {}
    const headers = await authHeaders();
    await fetch("/.netlify/functions/push-unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
  }
}

// ---- small util: convert VAPID public key ----
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
