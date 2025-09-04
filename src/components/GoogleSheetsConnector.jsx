import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function randomId(prefix="wh_u_") {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return prefix + Array.from(arr).map(b => b.toString(16).padStart(2,"0")).join("");
}
function randomSecretB64() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr));
}

export default function GoogleSheetsConnector() {
  const [user, setUser] = useState(null);
  const [hook, setHook] = useState(null);
  const [loading, setLoading] = useState(true);

  // get current user
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data?.user || null));
  }, []);

  // fetch existing hook for this user (if any)
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data, error } = await supabase
        .from("user_inbound_webhooks")
        .select("id, secret, active, last_used_at")
        .eq("user_id", user.id)
        .limit(1);
      if (!error) setHook(data?.[0] || null);
      setLoading(false);
    })();
  }, [user]);

  async function createHook() {
    if (!user) return;
    setLoading(true);
    const id = randomId();
    const secret = randomSecretB64();
    const { data, error } = await supabase
      .from("user_inbound_webhooks")
      .insert([{ id, user_id: user.id, secret }])
      .select("id, secret, active, last_used_at")
      .single();
    if (error) {
      alert("Could not create webhook: " + error.message);
    } else {
      setHook(data);
    }
    setLoading(false);
  }

  const fnUrlBase = `${window.location.origin}/.netlify/functions/gsheet-webhook`;
  const webhookUrl = hook ? `${fnUrlBase}?id=${hook.id}` : "";

  const appsScript = useMemo(() => {
    if (!hook) return "";
    return `/**
 * Google Sheets → Remie CRM (per-user)
 * 1) Run setupConfig() once (authorize)
 * 2) Add Trigger: onAnyChange (From spreadsheet → On change)
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
  Logger.log("Config saved.");
}

function onAnyChange(e) { try { postNewRowsSinceLastPointer(); } catch (err) { console.error(err); } }
function syncNewRows() { postNewRowsSinceLastPointer(); }

function postNewRowsSinceLastPointer() {
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
  const headers = sheet.getRange(HEADER_ROW_INDEX, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const rows = sheet.getRange(lastPosted + 1, 1, lastRow - lastPosted, lastCol).getValues();

  rows.forEach((rowVals, idx) => {
    const record = {};
    headers.forEach((h, i) => { if (h) record[h.toLowerCase()] = rowVals[i]; });
    if (!record.created_at) record.created_at = new Date().toISOString();

    const body = JSON.stringify(record);
    const sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(body, secret));
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: body,
      headers: { "X-Signature": sig },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      props.setProperty(STATE_LAST_ROW, String(lastPosted + idx + 1));
    } else {
      console.error("Webhook failed", code, res.getContentText());
    }
  });
}`;
  }, [hook, webhookUrl]);

  if (loading) {
    return <div className="p-4 border rounded-lg">Loading Google Sheets connector…</div>;
  }

  return (
    <div className="p-4 border rounded-lg space-y-3">
      <div className="text-lg font-semibold">Google Sheets Import</div>

      {!hook && (
        <button
          onClick={createHook}
          className="px-3 py-2 rounded-xl bg-black text-white shadow"
        >
          Generate My Webhook
        </button>
      )}

      {hook && (
        <div className="space-y-2">
          <div className="text-sm">
            <b>Webhook URL:</b> <code className="break-all">{webhookUrl}</code>
          </div>
          <div className="text-sm">
            <b>Secret:</b> <code className="break-all">{hook.secret}</code>
          </div>

          <ol className="list-decimal ml-6 text-sm space-y-1">
            <li>Open your Google Sheet → <b>Extensions → Apps Script</b>.</li>
            <li>Paste the script below, then run <code>setupConfig()</code> once and approve permissions.</li>
            <li>Go to <b>Triggers</b> → add trigger for <code>onAnyChange</code> → “From spreadsheet / On change”.</li>
            <li>Headers needed in row 1: <code>name, phone, email</code> (at least one of these). Optional: <code>state, notes, created_at</code>.</li>
            <li>Add a test row — it’ll appear in your CRM automatically.</li>
          </ol>

          <textarea
            readOnly
            value={appsScript}
            className="w-full h-80 p-2 border rounded-md"
          />

          <div className="text-xs text-gray-500">
            Tip: You can rotate or disable this webhook later by deleting and regenerating it.
          </div>
        </div>
      )}
    </div>
  );
}
