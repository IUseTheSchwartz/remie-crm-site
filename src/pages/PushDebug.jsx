import { useEffect, useState } from "react";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export default function PushDebug() {
  const [status, setStatus] = useState([]);
  const log = (m) => setStatus((s) => [String(m), ...s].slice(0, 50));

  useEffect(() => {
    log(`Display mode: ${window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'}`);
    log(`Notification permission: ${Notification?.permission || 'n/a'}`);
    log(`VAPID key present: ${VAPID_PUBLIC_KEY ? 'yes' : 'no'}`);
  }, []);

  async function ensureSW() {
    try {
      if (!('serviceWorker' in navigator)) throw new Error('No serviceWorker API');
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      log('SW ready ✅');
      return reg;
    } catch (e) {
      log(`SW error: ${e.message}`);
      throw e;
    }
  }

  async function subscribeNow() {
    try {
      const reg = await ensureSW();

      // iOS: must be triggered by a user gesture
      const perm = await Notification.requestPermission();
      log(`Notification.requestPermission(): ${perm}`);
      if (perm !== 'granted') return;

      if (!('pushManager' in reg)) throw new Error('No pushManager on registration');
      const exists = await reg.pushManager.getSubscription();
      if (exists) {
        log('Already subscribed. ✅');
        return;
      }

      const keyUint8 = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyUint8,
      });

      log('Subscribed ✅');
      // send to backend
      const res = await fetch('/.netlify/functions/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      log(`push-subscribe → ${res.status}`);
    } catch (e) {
      log(`Subscribe error: ${e.message}`);
    }
  }

  async function sendTest() {
    try {
      const r = await fetch('/.netlify/functions/_push?test=1');
      log(`_push?test=1 → ${r.status}`);
    } catch (e) {
      log(`Test push error: ${e.message}`);
    }
  }

  return (
    <div className="p-4 text-white space-y-4">
      <h1 className="text-xl font-semibold">Push Debug</h1>
      <div className="space-y-2">
        <button onClick={ensureSW} className="rounded-lg border border-white/20 bg-white/10 px-3 py-2">1) Register SW</button>
        <button onClick={subscribeNow} className="rounded-lg border border-white/20 bg-white/10 px-3 py-2">2) Enable Notifications</button>
        <button onClick={sendTest} className="rounded-lg border border-white/20 bg-white/10 px-3 py-2">3) Send Test Push</button>
      </div>
      <div className="rounded-xl border border-white/10 bg-black/40 p-3 text-xs max-h-64 overflow-auto">
        {status.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
