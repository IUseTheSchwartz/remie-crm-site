// File: src/components/ZapierConnector.jsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const API_PATH = "/.netlify/functions/user-webhook";

export default function ZapierConnector() {
  const [hook, setHook] = useState({ id: "", secret: "" });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const { data: ses } = await supabase.auth.getSession();
        const token = ses?.session?.access_token;
        if (!token) throw new Error("Please sign in to set up Zapier.");

        // Read or create per-user webhook (id + secret)
        const res = await fetch(API_PATH, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) throw new Error(`Fetch webhook failed (${res.status})`);
        const json = await res.json();
        if (!cancelled) setHook({ id: json.id, secret: json.secret });
      } catch (e) {
        if (!cancelled) setErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function rotateSecret() {
    setLoading(true);
    setErr("");
    try {
      const { data: ses } = await supabase.auth.getSession();
      const token = ses?.session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const res = await fetch(API_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rotate: true }),
      });

      if (!res.ok) throw new Error(`Rotate failed (${res.status})`);
      const json = await res.json();
      setHook({ id: json.id, secret: json.secret });
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const webhookUrl = useMemo(() => {
    return hook.id
      ? `${window.location.origin}/.netlify/functions/zap-webhook`
      : "—";
  }, [hook.id]);

  function copy(text) {
    if (!text) return;
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="space-y-4 text-sm">
      <h2 className="text-lg font-semibold">Zapier: Auto-Import Leads</h2>

      {err && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          {err}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <p className="mb-2">
          <strong>Endpoint (URL):</strong>{" "}
          <span className="break-all">{webhookUrl}</span>
        </p>
        <p className="mb-2">
          <strong>Auth Type:</strong> Basic Auth
        </p>
        <p className="mb-1">
          <strong>Username:</strong> <span className="break-all">{hook.id || "—"}</span>
        </p>
        <p>
          <strong>Password:</strong> <span className="break-all">{hook.secret || "—"}</span>
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => copy(webhookUrl)}
            disabled={!hook.id || loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy URL"
          >
            Copy URL
          </button>
          <button
            onClick={() => copy(hook.id)}
            disabled={!hook.id || loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy Username"
          >
            Copy Username
          </button>
          <button
            onClick={() => copy(hook.secret)}
            disabled={!hook.secret || loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy Password"
          >
            Copy Password
          </button>
          <button
            onClick={rotateSecret}
            disabled={loading || !hook.id}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1"
            title="Rotate secret"
          >
            Rotate secret
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="font-medium">Zap steps (per user):</div>
        <ol className="list-decimal list-inside space-y-1">
          <li>Trigger: <em>Google Sheets → New/Updated Row</em> (choose the sheet + tab).</li>
          <li>(Optional) Add <em>Formatter</em> steps to clean phone/email.</li>
          <li>
            Action: <em>Webhooks by Zapier → Custom Request</em>
            <ul className="ml-5 list-disc">
              <li><strong>Method:</strong> POST</li>
              <li><strong>URL:</strong> <code>{webhookUrl}</code></li>
              <li><strong>Data (JSON):</strong> include fields like <code>name, phone, email, state, notes, military_branch, beneficiary, beneficiary_name</code></li>
              <li><strong>Headers:</strong> <code>Content-Type: application/json</code></li>
              <li><strong>Auth Type:</strong> Basic Auth</li>
              <li><strong>Username:</strong> <code>{hook.id || "your_webhook_id"}</code></li>
              <li><strong>Password:</strong> <code>{hook.secret || "your_secret"}</code></li>
            </ul>
          </li>
          <li>Turn the Zap ON and add a test row in Google Sheets.</li>
        </ol>
        <p className="text-xs text-white/50">
          When a row posts, we create the lead, update the contact with
          correct tags, and auto-send the new-lead text (military template if
          <code>military_branch</code> is present).
        </p>
      </div>
    </div>
  );
}
