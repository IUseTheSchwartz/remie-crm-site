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
        // Get or create per-user webhook via server function
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

  function copy(t) {
    if (!t) return;
    navigator.clipboard.writeText(t);
  }

  const zapierCodeStep = useMemo(() => {
    // This is the exact JS you can paste in a "Code by Zapier" (Run Javascript) step.
    // Input Data (on the step): body, secret
    //  - body: stringified JSON you will POST to the webhook
    //  - secret: paste the Secret from this page
    return `// "Code by Zapier" (Run Javascript)
// Input Data: body (string), secret (string)
// Output: { signature } to use as the X-Signature header

const crypto = require('crypto');

if (typeof inputData.body !== 'string') {
  throw new Error('Expected inputData.body to be a JSON string');
}
if (!inputData.secret) {
  throw new Error('Missing secret');
}

const hmac = crypto.createHmac('sha256', inputData.secret)
  .update(inputData.body, 'utf8')
  .digest('base64');

return { signature: hmac };`;
  }, []);

  const zapierCurlExample = useMemo(() => {
    const sample = JSON.stringify({
      name: "Jane Zap",
      phone: "(555) 111-2222",
      email: "jane@example.com",
      state: "TN",
      notes: "From Zapier",
      created_at: new Date().toISOString(),
    }, null, 2);

    return `# Example final step (Webhooks by Zapier → Custom Request)
# Method: POST
# URL: ${webhookUrl}
# Headers:
#   Content-Type: application/json
#   X-Signature: {{steps.code_by_zapier.signature}}
# Data: (Raw) use the same JSON you signed in the Code step

curl -X POST \\
  -H "Content-Type: application/json" \\
  -H "X-Signature: REPLACE_WITH_SIGNATURE_FROM_CODE_STEP" \\
  -d '${sample.replace(/\n/g, "")}' \\
  "${webhookUrl}"`;
  }, [webhookUrl]);

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
          <button
            onClick={() => copy(webhookUrl)}
            disabled={!hook.id || loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy Webhook URL"
          >
            Copy URL
          </button>
          <button
            onClick={() => copy(hook.secret)}
            disabled={!hook.secret || loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy Secret"
          >
            Copy Secret
          </button>
          <button
            onClick={rotateSecret}
            disabled={!hook.id || loading}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1"
            title="Rotate secret"
          >
            Rotate secret
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <div className="mb-2 font-medium">How to build the Zap</div>
        <ol className="list-decimal list-inside space-y-1">
          <li>Trigger: <strong>Google Sheets</strong> → New or Updated Row.</li>
          <li>Action: <strong>Formatter by Zapier</strong> (optional) to clean up phone/email.</li>
          <li>
            Action: <strong>Code by Zapier (Run Javascript)</strong> — paste the code below.
            Provide two inputs: <code>body</code> (the JSON string you will POST) and
            <code> secret</code> (paste the Secret from above).
          </li>
          <li>
            Action: <strong>Webhooks by Zapier → Custom Request</strong>.
            Method: <code>POST</code> to the Webhook URL above.
            Headers: <code>Content-Type: application/json</code> and <code>X-Signature</code> from the Code step output.
            Data: the exact JSON string you signed.
          </li>
        </ol>
      </div>

      <div>
        <div className="mb-1 font-medium">Code by Zapier — JavaScript</div>
        <pre className="max-h-[320px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
{zapierCodeStep}
        </pre>
        <div className="mt-2">
          <button
            onClick={() => copy(zapierCodeStep)}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
          >
            Copy code
          </button>
        </div>
      </div>

      <div>
        <div className="mb-1 font-medium">cURL example of the final request</div>
        <pre className="max-h-[280px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
{zapierCurlExample}
        </pre>
        <div className="mt-2">
          <button
            onClick={() => copy(zapierCurlExample)}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
          >
            Copy example
          </button>
        </div>
      </div>

      <p className="text-xs text-white/50">
        Notes: Your webhook validates the signature (HMAC-SHA256, base64). If verification fails, the lead is rejected.
        After a valid POST, the server inserts/merges the lead, upserts the contact/tags, checks your wallet, and sends the correct template (military-aware).
        Client-side realtime updates simply display the new lead; <em>texting is handled entirely on the server</em>.
      </p>
    </div>
  );
}
