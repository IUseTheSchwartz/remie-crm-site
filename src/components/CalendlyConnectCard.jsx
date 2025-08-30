import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function CalendlyConnectCard() {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      setChecking(true);
      try {
        const session = (await supabase.auth.getSession()).data.session;
        if (!session) setConnected(false);
        else {
          const res = await fetch("/.netlify/functions/calendly-events", {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          const json = await res.json().catch(() => ({}));
          setConnected(json?.error !== "not_connected");
        }
      } catch {
        setConnected(false);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  async function startConnect() {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) return alert("Please log in");
    window.location.href = "/.netlify/functions/calendly-auth-start";
  }

  async function disconnect() {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) return alert("Please log in");
    await fetch("/.netlify/functions/calendly-disconnect", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setConnected(false);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 text-sm font-semibold">Calendly</div>
      {checking ? (
        <div className="text-sm text-white/60">Checking…</div>
      ) : connected ? (
        <div className="flex items-center gap-3">
          <div className="text-sm text-emerald-300">Connected</div>
          <button onClick={disconnect} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">
            Disconnect
          </button>
        </div>
      ) : (
        <button onClick={startConnect} className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200">
          Connect Calendly
        </button>
      )}
    </div>
  );
}
