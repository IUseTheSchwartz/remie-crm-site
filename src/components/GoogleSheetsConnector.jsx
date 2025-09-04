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
 * How to set up:
 * 1) Paste this file in Extensions → Apps Script.
 * 2) Run setupConfig() once and approve permissions.
 * 3) Add trigger: From spreadsheet → On change → onAnyChange.
 *    (Optional) Add time-driven trigger: syncNewRows every 1–5 minutes.
 */

const WEBHOOK_URL_PROP = "WEBHOOK_URL";
const WEBHOOK_SECRET_PROP = "WEBHOOK_SECRET";
const HEADER_ROW_INDEX = 1;       // headers are on row 1
const STATE_LAST_ROW = "LAST_POSTED_ROW";

/** 🔧 Fill these in (already set for you) and run setupConfig() once. */
function setupConfig() {
  const props = PropertiesService.getScriptProperties();

  // ✅ Your Netlify function webhook URL with ?id=...
  props.setProperty(
    WEBHOOK_URL_PROP,
    "https://remiecrm.com/.netlify/functions/gsheet-webhook?id=wh_u_ce23951f1112a5c4"
  );

  // ✅ Your exact webhook secret
  props.setProperty(
    WEBHOOK_SECRET_PROP,
    "G8WUZ36r2SMw267bjYHZi0e+N2aolIb7fv2O6Tp3Nww="
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
    const name = (nameFromFull || `${first} ${last}`.trim()).trim();

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
}
`;
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
