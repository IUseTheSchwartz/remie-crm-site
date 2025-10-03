// File: src/components/autoimport/ZapierEmbed.jsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const API_PATH = "/.netlify/functions/user-webhook";

export default function ZapierEmbed() {
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
        if (!token) throw new Error("Please sign in to set up Zapier import.");

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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
      ? `${window.location.origin}/.netlify/functions/gsheet-webhook?id=${hook.id}`
      : "—";
  }, [hook.id]);

  function copy(t) { if (t) navigator.clipboard.writeText(t); }

  const zapierCurlBasic = useMemo(() => {
    const sample = JSON.stringify({
      name: "Zap Sample",
      phone: "(555) 111-2222",
      email: "zap@example.com",
      state: "TN",
      notes: "From Zapier (Basic Auth)",
      created_at: new Date().toISOString(),
    });
    return `# Webhooks by Zapier → Custom Request (Basic Auth)
# Method: POST
# URL: ${webhookUrl}
# Basic Auth: username='${hook.id}'  password='${hook.secret}'
# Headers:
#   Content-Type: application/json
# Body: raw JSON (the same fields your sheet provides)

curl -X POST \\
  -u "${hook.id}:${hook.secret}" \\
  -H "Content-Type: application/json" \\
  -d '${sample}' \\
  "${webhookUrl}"`;
  }, [hook.id, hook.secret, webhookUrl]);

  const zapierCodeStep = `// "Code by Zapier" (Run Javascript)
// Input Data: body (string), secret (string)
const crypto = require('crypto');
if (typeof inputData.body !== 'string') throw new Error('Expected body to be a JSON string');
if (!inputData.secret) throw new Error('Missing secret');
const hmac = crypto.createHmac('sha256', inputData.secret).update(inputData.body, 'utf8').digest('base64');
return { signature: hmac };`;

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Zapier: Google Sheets → Remie CRM</h3>

      {err && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          {err}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <div className="mb-2 font-medium">Your Webhook (per user)</div>
        <p className="mb-1"><strong>Webhook URL:</strong> <span className="break-all">{webhookUrl}</span></p>
        <p className="mb-2"><strong>Secret:</strong> <span className="break-all">{hook.secret || "—"}</span></p>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => copy(webhookUrl)} disabled={!hook.id || loading} className="rounded-md border border-white/15 bg-white/5 px-3 py-1">Copy URL</button>
          <button onClick={() => copy(hook.secret)} disabled={!hook.secret || loading} className="rounded-md border border-white/15 bg-white/5 px-3 py-1">Copy Secret</button>
          <button onClick={rotateSecret} disabled={!hook.id || loading} className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1">Rotate secret</button>
        </div>
      </div>

      {/* NO-CODE PATH */}
      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <div className="mb-2 font-medium">No-code (recommended): Webhooks + Basic Auth</div>
        <ol className="list-decimal list-inside space-y-1">
          <li>Trigger: <strong>Google Sheets</strong> → New or Updated Row.</li>
          <li>Action: <strong>Webhooks by Zapier</strong> → Custom Request.</li>
          <li>Method: <code>POST</code>, URL: <code>{webhookUrl}</code>.</li>
          <li>Auth: choose <strong>Basic Auth</strong>. Username: <code>{hook.id || "…"}</code>, Password: <code>{hook.secret || "…"}</code>.</li>
          <li>Headers: <code>Content-Type: application/json</code>.</li>
          <li>Data: build a JSON body mapping your sheet fields (name, phone, email, state, notes, etc.).</li>
        </ol>
        <div className="mt-2">
          <div className="mb-1 font-medium">cURL example</div>
          <pre className="max-h-[240px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
{zapierCurlBasic}
          </pre>
          <button onClick={() => copy(zapierCurlBasic)} className="rounded-md border border-white/15 bg-white/5 px-3 py-1">Copy example</button>
        </div>
      </div>

      {/* ADVANCED PATH (kept for compatibility) */}
      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <div className="mb-2 font-medium">Advanced: HMAC signature (optional)</div>
        <p className="mb-2 text-white/70">
          If you prefer to sign requests, add a <em>Code by Zapier (Run Javascript)</em> step to compute <code>X-Signature</code> and send it with your POST.
        </p>
        <pre className="max-h-[280px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
{zapierCodeStep}
        </pre>
        <button onClick={() => copy(zapierCodeStep)} className="rounded-md border border-white/15 bg-white/5 px-3 py-1">Copy code</button>
      </div>

      <p className="text-xs text-white/50">
        Tip: Use <code>netlify dev</code> during development so <code>/.netlify/functions/*</code> resolves locally. You must be signed in for this page to load your per-user webhook.
      </p>
    </div>
  );
}
