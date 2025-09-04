// File: src/components/GoogleSheetsConnector.jsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient"; // your browser Supabase client

const API_PATH = "/.netlify/functions/user-webhook"; // server path (primary), will fallback if 401

export default function GoogleSheetsConnector() {
  const [hook, setHook] = useState({ id: "", secret: "" });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        // Try server first (sends Bearer token)
        const { data: ses } = await supabase.auth.getSession();
        const token = ses?.session?.access_token;
        if (!token) throw new Error("Please sign in to set up Google Sheets import.");

        const res = await fetch(API_PATH, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const json = await res.json();
          if (!cancelled) setHook({ id: json.id, secret: json.secret });
        } else {
          // If unauthorized/missing endpoint, fall back to client-side Supabase
          if (res.status === 401 || res.status === 404) {
            const got = await loadOrCreateWebhookViaSupabase();
            if (!cancelled) setHook(got);
          } else {
            throw new Error(`Fetch webhook failed (${res.status})`);
          }
        }
      } catch (e) {
        // Final fallback: try client-side once if we haven’t yet
        try {
          const got = await loadOrCreateWebhookViaSupabase();
          if (!cancelled) setHook(got);
        } catch (ee) {
          if (!cancelled) setErr((e?.message || e) + "");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function loadOrCreateWebhookViaSupabase() {
    // Requires RLS policy: user can select/insert/update where user_id = auth.uid()
    // 1) read existing
    const { data: rows, error: selErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, secret, active")
      .eq("active", true)
      .limit(1);

    if (selErr) throw selErr;

    if (rows && rows.length) {
      return { id: rows[0].id, secret: rows[0].secret };
    }

    // 2) create new
    const id = makeWebhookId();
    const secret = b64Secret(32);
    const { error: insErr } = await supabase
      .from("user_inbound_webhooks")
      .insert([{ id, secret, active: true }]);
    if (insErr) throw insErr;

    return { id, secret };
  }

  async function rotateSecret() {
    setLoading(true);
    setErr("");
    try {
      // Try server rotate first
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

      if (res.ok) {
        const json = await res.json();
        setHook({ id: json.id, secret: json.secret });
        return;
      }

      // Fallback: rotate via Supabase directly
      const secret = b64Secret(32);
      const { data, error } = await supabase
        .from("user_inbound_webhooks")
        .update({ secret })
        .eq("id", hook.id)
        .eq("active", true)
        .select("id, secret")
        .limit(1);

      if (error) throw error;
      setHook({ id: data?.[0]?.id || hook.id, secret: data?.[0]?.secret || secret });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const webhookUrl = useMemo(() => {
    return hook.id
      ? `${window.location.origin}/.netlify/functions/gsheet-webhook?id=${hook.id}`
      : "—";
  }, [hook.id]);

  const scriptText = useMemo(() => {
    // EXACT script you supplied, with id/secret injected
    return `/**
 * Google Sheets → Remie CRM (per-user)
 * How to set up:
 * 1) Paste this file in Extensions → Apps Script.
 * 2) Run setupConfig() once and approve permissions.
 * 3) Add trigger: From spreadsheet → On change → onAnyChange.
 *    (Optional) Add time-driven trigger: syncNewRows every 1–5 minutes.
 */

const WEBHOOK_URL_PROP = "WEBHOOK_URL";
const WEBHOOK_SECRET_PROP = "WEBHOOK_SECRET";
const HEADER_ROW_INDEX = 1; // headers are on row 1
const STATE_LAST_ROW = "LAST_POSTED_ROW";

/** 🔧 Fill these in (already set for you) and run setupConfig() once. */
function setupConfig() {
  const props = PropertiesService.getScriptProperties();

  // ✅ Your Netlify function webhook URL with ?id=...
  props.setProperty(
    WEBHOOK_URL_PROP,
    "${webhookUrl}"
  );

  // ✅ Your exact webhook secret
  props.setProperty(
    WEBHOOK_SECRET_PROP,
    "${hook.secret}"
  );

  // Reset the pointer so the next run starts from the first data row
  props.deleteProperty(STATE_LAST_ROW);
  Logger.log("Config saved. Now add the trigger: From spreadsheet → On change → onAnyChange.");
}

/** Trigger: From spreadsheet → On change */
function onAnyChange(e) {
  try { postNewRowsSinceLastPointer(); } catch (err) { console.error(err); }
}

/** Optional: Time-driven (backup) */
function syncNewRows() { postNewRowsSinceLastPointer(); }

/** Core: read new rows after last pointer, normalize, sign, POST to webhook */
function postNewRowsSinceLastPointer() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(WEBHOOK_URL_PROP);
  const secret = props.getProperty(WEBHOOK_SECRET_PROP);
  if (!url || !secret) throw new Error("Missing URL/SECRET. Run setupConfig().");

  const lastPosted = parseInt(props.getProperty(STATE_LAST_ROW) || String(HEADER_ROW_INDEX), 10);
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX || lastRow <= lastPosted) return; // nothing new

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW_INDEX, 1, 1, lastCol).getValues()[0]
    .map(h => String(h || "").trim());

  // lowercase index: "first name" -> column position
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h.toLowerCase()] = i; });

  // Common aliases → canonical keys expected by your webhook
  const A = {
    name:        ["name","full name","fullname","full_name"],
    first:       ["first","first name","firstname","given name","given_name","fname","first_name"],
    last:        ["last","last name","lastname","surname","family name","lname","last_name","family_name"],
    email:       ["email","e-mail","email address","mail","email_address"],
    phone:       ["phone","phone number","mobile","cell","tel","telephone","number","phone_number"],
    notes:       ["notes","note","comments","comment","details"],
    company:     ["company","business","organization","organisation"],
    dob:         ["dob","date of birth","birthdate","birth date","d.o.b.","date"],
    state:       ["state","st","us state","residence state"],
    beneficiary: ["beneficiary","beneficiary type"],
    beneficiary_name: ["beneficiary name","beneficiary_name","beneficiary full name"],
    gender:      ["gender","sex"]
  };

  const getVal = (rowVals, keys) => {
    for (const k of keys) {
      const pos = idx[k];
      if (pos !== undefined) {
        const v = rowVals[pos];
        if (v !== null && v !== "") return v;
      }
    }
    return "";
  };

  // All new rows after the pointer
  const range = sheet.getRange(lastPosted + 1, 1, lastRow - lastPosted, lastCol);
  const rows = range.getValues();

  rows.forEach((rowVals, i) => {
    // Build canonical record
    const first = String(getVal(rowVals, A.first) || "").trim();
    const last  = String(getVal(rowVals, A.last) || "").trim();
    const nameFromFull = String(getVal(rowVals, A.name) || "").trim();
    const name = (nameFromFull || \`\${first} \${last}\`.trim()).trim();

    // Coerce everything to string (Apps Script may produce numbers/dates)
    const record = {
      name: name,
      phone: String(getVal(rowVals, A.phone) || ""),
      email: String(getVal(rowVals, A.email) || ""),
      state: String(getVal(rowVals, A.state) || ""),
      notes: String(getVal(rowVals, A.notes) || ""),
      dob: String(getVal(rowVals, A.dob) || ""),
      beneficiary: String(getVal(rowVals, A.beneficiary) || ""),
      beneficiary_name: String(getVal(rowVals, A.beneficiary_name) || ""),
      gender: String(getVal(rowVals, A.gender) || ""),
      company: String(getVal(rowVals, A.company) || ""),
      created_at: new Date().toISOString(),
    };

    // If row is truly empty (no identifiers), skip
    if (!record.name && !record.phone && !record.email) return;

    const body = JSON.stringify(record);
    const sig = Utilities.base64Encode(
      Utilities.computeHmacSha256Signature(body, secret)
    );

    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: body,
      headers: { "X-Signature": sig },
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      // advance pointer for each successful row
      props.setProperty(STATE_LAST_ROW, String(lastPosted + i + 1));
    } else {
      // keep pointer on failure so the row can retry on next run
      console.error("Webhook failed", code, res.getContentText());
    }
  });
}`.trim();
  }, [hook.secret, webhookUrl]);

  function copy(text) {
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="space-y-4 text-sm">
      <h2 className="text-lg font-semibold">Google Sheets Import</h2>

      {err && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => copy(webhookUrl)}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
          disabled={!hook.id || loading}
          title="Copy Webhook URL"
        >
          Copy Webhook URL
        </button>
        <button
          onClick={() => copy(hook.secret)}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
          disabled={!hook.secret || loading}
          title="Copy Secret"
        >
          Copy Secret
        </button>
        <button
          onClick={() => copy(scriptText)}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
          disabled={loading || !hook.id}
          title="Copy Apps Script"
        >
          Copy Apps Script
        </button>
        <button
          onClick={rotateSecret}
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1"
          disabled={loading || !hook.id}
          title="Rotate secret"
        >
          Rotate secret
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <p className="mb-2">
          <strong>Webhook URL:</strong>{" "}
          <span className="break-all">{webhookUrl}</span>
        </p>
        <p>
          <strong>Secret:</strong>{" "}
          <span className="break-all">{hook.secret || "—"}</span>
        </p>
      </div>

      <ol className="list-decimal list-inside space-y-1">
        <li>Open your Google Sheet → <em>Extensions → Apps Script</em>.</li>
        <li>Paste the script below, then run <code>setupConfig()</code> once and authorize.</li>
        <li>Go to <em>Triggers</em> → add trigger for <code>onAnyChange</code> → “From spreadsheet / On change”.</li>
        <li>
          Headers in row&nbsp;1: <code>name</code>, <code>phone</code>, <code>email</code> (any one is fine).
          Optional: <code>state</code>, <code>notes</code>, <code>dob</code>, <code>company</code>, etc.
        </li>
        <li>Add a test row — it’ll appear in your CRM automatically.</li>
      </ol>

      <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
        {scriptText}
      </pre>

      <p className="text-xs text-white/50">
        Tip: You can rotate or disable this webhook later by clicking “Rotate secret”.
      </p>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function b64Secret(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  buf.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function makeWebhookId() {
  const rnd = crypto.randomUUID().replace(/-/g, "");
  return `wh_u_${rnd.slice(0, 8)}${rnd.slice(8, 16)}`;
}
