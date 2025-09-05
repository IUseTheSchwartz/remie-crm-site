// File: src/components/GoogleSheetsConnector.jsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const API_PATH = "/.netlify/functions/user-webhook";

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
        // Try server first
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
          // Fallback to direct Supabase for 401/404
          if (res.status === 401 || res.status === 404) {
            const got = await loadOrCreateWebhookViaSupabase();
            if (!cancelled) setHook(got);
          } else {
            throw new Error(`Fetch webhook failed (${res.status})`);
          }
        }
      } catch (e) {
        try {
          const got = await loadOrCreateWebhookViaSupabase();
          if (!cancelled) setHook(got);
        } catch (ee) {
          if (!cancelled) setErr(e?.message || String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function loadOrCreateWebhookViaSupabase() {
    // MUST include user_id to satisfy RLS
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new Error("Not signed in.");

    // Select existing for this user
    const { data: rows, error: selErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, secret, active")
      .eq("user_id", userId)
      .eq("active", true)
      .limit(1);

    if (selErr) throw selErr;
    if (rows && rows.length) return { id: rows[0].id, secret: rows[0].secret };

    // Create new with user_id set
    const id = makeWebhookId();
    const secret = b64Secret(32);
    const { error: insErr } = await supabase
      .from("user_inbound_webhooks")
      .insert([{ id, user_id: userId, secret, active: true }]); // ← user_id here

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

      // Fallback: rotate directly
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;

      const newSecret = b64Secret(32);
      const { data, error } = await supabase
        .from("user_inbound_webhooks")
        .update({ secret: newSecret })
        .eq("id", hook.id)
        .eq("user_id", userId)
        .eq("active", true)
        .select("id, secret")
        .limit(1);

      if (error) throw error;
      setHook({ id: data?.[0]?.id || hook.id, secret: data?.[0]?.secret || newSecret });
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
const HEADER_ROW_INDEX = 1;
const STATE_LAST_ROW = "LAST_POSTED_ROW";

function setupConfig() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(WEBHOOK_URL_PROP, "${webhookUrl}");
  props.setProperty(WEBHOOK_SECRET_PROP, "${hook.secret}");
  props.deleteProperty(STATE_LAST_ROW);
  Logger.log("Config saved. Now add the trigger: From spreadsheet → On change → onAnyChange.");
}
function onAnyChange(e){try{postNewRowsSinceLastPointer()}catch(err){console.error(err)}}
function syncNewRows(){postNewRowsSinceLastPointer()}

function postNewRowsSinceLastPointer(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(WEBHOOK_URL_PROP);
  const secret = props.getProperty(WEBHOOK_SECRET_PROP);
  if (!url || !secret) throw new Error("Missing URL/SECRET. Run setupConfig().");

  const lastPosted = parseInt(props.getProperty(STATE_LAST_ROW) || String(HEADER_ROW_INDEX), 10);
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX || lastRow <= lastPosted) return;

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW_INDEX, 1, 1, lastCol).getValues()[0].map(h=>String(h||"").trim());
  const idx = {}; headers.forEach((h,i)=>{ if(h) idx[h.toLowerCase()] = i; });

  const A = {
    name:["name","full name","fullname","full_name"],
    first:["first","first name","firstname","given name","given_name","fname","first_name"],
    last:["last","last name","lastname","surname","family name","lname","last_name","family_name"],
    email:["email","e-mail","email address","mail","email_address"],
    phone:["phone","phone number","mobile","cell","tel","telephone","number","phone_number"],
    notes:["notes","note","comments","comment","details"],
    company:["company","business","organization","organisation"],
    dob:["dob","date of birth","birthdate","birth date","d.o.b.","date"],
    state:["state","st","us state","residence state"],
    beneficiary:["beneficiary","beneficiary type"],
    beneficiary_name:["beneficiary name","beneficiary_name","beneficiary full name"],
    gender:["gender","sex"]
  };
  const getVal=(row,keys)=>{ for (const k of keys){ const pos=idx[k]; if(pos!==undefined){ const v=row[pos]; if(v!==null && v!=="") return v; } } return ""; };

  const range = sheet.getRange(lastPosted+1, 1, lastRow-lastPosted, lastCol);
  const rows = range.getValues();
  rows.forEach((vals,i)=>{
    const first=String(getVal(vals,A.first)||"").trim();
    const last =String(getVal(vals,A.last)||"").trim();
    const nameFromFull=String(getVal(vals,A.name)||"").trim();
    const name=(nameFromFull||\`\${first} \${last}\`.trim()).trim();

    const record={
      name,
      phone:String(getVal(vals,A.phone)||""),
      email:String(getVal(vals,A.email)||""),
      state:String(getVal(vals,A.state)||""),
      notes:String(getVal(vals,A.notes)||""),
      dob:String(getVal(vals,A.dob)||""),
      beneficiary:String(getVal(vals,A.beneficiary)||""),
      beneficiary_name:String(getVal(vals,A.beneficiary_name)||""),
      gender:String(getVal(vals,A.gender)||""),
      company:String(getVal(vals,A.company)||""),
      created_at:new Date().toISOString(),
    };
    if(!record.name && !record.phone && !record.email) return;

    const body=JSON.stringify(record);
    const sig=Utilities.base64Encode(Utilities.computeHmacSha256Signature(body, secret));
    const resp=UrlFetchApp.fetch(url,{method:"post",contentType:"application/json",payload:body,headers:{"X-Signature":sig},muteHttpExceptions:true});
    const code=resp.getResponseCode();
    if(code>=200 && code<300){ props.setProperty(STATE_LAST_ROW, String(lastPosted+i+1)); }
    else{ console.error("Webhook failed", code, resp.getContentText()); }
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
        <button onClick={() => copy(webhookUrl)} className="rounded-md border border-white/15 bg-white/5 px-3 py-1" disabled={!hook.id || loading} title="Copy Webhook URL">
          Copy Webhook URL
        </button>
        <button onClick={() => copy(hook.secret)} className="rounded-md border border-white/15 bg-white/5 px-3 py-1" disabled={!hook.secret || loading} title="Copy Secret">
          Copy Secret
        </button>
        <button onClick={() => copy(scriptText)} className="rounded-md border border-white/15 bg-white/5 px-3 py-1" disabled={loading || !hook.id} title="Copy Apps Script">
          Copy Apps Script
        </button>
        <button onClick={rotateSecret} className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1" disabled={loading || !hook.id} title="Rotate secret">
          Rotate secret
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <p className="mb-2"><strong>Webhook URL:</strong> <span className="break-all">{webhookUrl}</span></p>
        <p><strong>Secret:</strong> <span className="break-all">{hook.secret || "—"}</span></p>
      </div>

      <ol className="list-decimal list-inside space-y-1">
        <li>Open your Google Sheet → <em>Extensions → Apps Script</em>.</li>
        <li>Paste the script below, then run <code>setupConfig()</code> once and authorize.</li>
        <li>Go to <em>Triggers</em> → add trigger for <code>onAnyChange</code> → “From spreadsheet / On change”.</li>
        <li>Headers in row 1: <code>name</code>, <code>phone</code>, or <code>email</code> (any one). Optional: <code>state</code>, <code>notes</code>, <code>dob</code>, <code>company</code>, etc.</li>
        <li>Add a test row — it’ll appear in your CRM automatically.</li>
      </ol>

      <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
        {scriptText}
      </pre>

      <p className="text-xs text-white/50">Tip: You can rotate or disable this webhook later by clicking “Rotate secret”.</p>
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