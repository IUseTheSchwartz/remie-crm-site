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
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new Error("Not signed in.");

    const { data: rows, error: selErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, secret, active")
      .eq("user_id", userId)
      .eq("active", true)
      .limit(1);

    if (selErr) throw selErr;
    if (rows && rows.length) return { id: rows[0].id, secret: rows[0].secret };

    const id = makeWebhookId();
    const secret = b64Secret(32);
    const { error: insErr } = await supabase
      .from("user_inbound_webhooks")
      .insert([{ id, user_id: userId, secret, active: true }]);

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

  // ---- Apps Script (adds military_branch alias + field) ----
  const scriptText = useMemo(() => {
    const url = webhookUrl;
    const secret = hook.secret || "";
    return `/**
 * Google Sheets → Remie CRM (per-user)
 *
 * Setup:
 * 1) Paste this whole file in Extensions → Apps Script.
 * 2) Edit setupConfig() with your Webhook URL + Secret (pre-filled here).
 * 3) Run setupConfig() once (authorize).
 * 4) Add trigger: From spreadsheet → On change → onAnyChange.
 *    (Optional) Add time-driven trigger: syncNewRows every 1–5 minutes (handy for backfill).
 */

const WEBHOOK_URL_PROP = "WEBHOOK_URL";
const WEBHOOK_SECRET_PROP = "WEBHOOK_SECRET";
const HEADER_ROW_INDEX = 1;             // headers on row 1
const STATE_LAST_ROW = "LAST_POSTED_ROW";
const MAX_ROWS_PER_RUN = 200;           // chunk size per run (tune to your needs)

// Optional: lock to a specific tab. Leave "" to use the active tab.
const SHEET_NAME = ""; // e.g., "Leads"

/** One-time (or when URL/secret changes). Initializes pointer to current last row. */
function setupConfig() {
  const props = PropertiesService.getScriptProperties();

  // ✅ YOUR webhook URL with ?id=...
  props.setProperty(WEBHOOK_URL_PROP, "${url}");

  // ✅ YOUR exact webhook secret
  props.setProperty(WEBHOOK_SECRET_PROP, "${secret}");

  // Initialize pointer to current last row → only FUTURE rows will send
  const sheet = getTargetSheet();
  const lastRow = sheet.getLastRow();
  const initPtr = Math.max(lastRow, HEADER_ROW_INDEX);
  props.setProperty(STATE_LAST_ROW, String(initPtr));

  Logger.log(
    "Config saved. Pointer set to current last row (%s). New rows AFTER this will post.",
    lastRow
  );
}

/** Trigger: From spreadsheet → On change */
function onAnyChange(e) {
  try { postNewRowsSinceLastPointer(); } catch (err) { console.error(err); }
}

/** Optional: time-driven trigger (every 1–5 minutes is good for backfill) */
function syncNewRows() { postNewRowsSinceLastPointer(); }

/** Core: send rows AFTER the pointer (in chunks), then advance pointer */
function postNewRowsSinceLastPointer() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(WEBHOOK_URL_PROP);
  const secret = props.getProperty(WEBHOOK_SECRET_PROP);
  if (!url || !secret) throw new Error("Missing URL/SECRET. Run setupConfig().");

  const sheet = getTargetSheet();
  const lastPosted = parseInt(props.getProperty(STATE_LAST_ROW) || String(HEADER_ROW_INDEX), 10);
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX || lastRow <= lastPosted) {
    Logger.log("Nothing to send. lastPosted=%s, lastRow=%s", lastPosted, lastRow);
    return;
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW_INDEX, 1, 1, lastCol).getValues()[0]
    .map(h => String(h || "").trim());

  // Build a lowercase header→index map
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h.toLowerCase()] = i; });

  // Column aliases → canonical keys your webhook expects
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
    gender:      ["gender","sex"],
    military_branch: ["military","military branch","branch","service branch"]
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

  // Read all new rows after the pointer
  const totalNew = lastRow - lastPosted;
  const toSend = Math.min(totalNew, MAX_ROWS_PER_RUN);
  const range = sheet.getRange(lastPosted + 1, 1, toSend, lastCol);
  const rows = range.getValues();

  Logger.log("Sending up to %s rows (from %s to %s, lastRow=%s)", toSend, lastPosted + 1, lastPosted + toSend, lastRow);

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = lastPosted + i + 1;
    const rowVals = rows[i];

    // Build canonical record
    const first = String(getVal(rowVals, A.first) || "").trim();
    const last  = String(getVal(rowVals, A.last) || "").trim();
    const nameFromFull = String(getVal(rowVals, A.name) || "").trim();
    const name = (nameFromFull || \`\${first} \${last}\`.trim()).trim();

    // Coerce everything to string
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
      military_branch: String(getVal(rowVals, A.military_branch) || ""),
      company: String(getVal(rowVals, A.company) || ""),
      created_at: new Date().toISOString(),
    };

    if (!record.name && !record.phone && !record.email) {
      Logger.log("Row %s skipped (no identifiers).", rowIndex);
      // advance pointer over empty rows too
      props.setProperty(STATE_LAST_ROW, String(rowIndex));
      continue;
    }

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
    const text = res.getContentText();
    Logger.log("Row %s → Webhook response (%s): %s", rowIndex, code, text);

    if (code >= 200 && code < 300) {
      try {
        const json = JSON.parse(text || "{}");
        // Advance pointer ONLY if backend confirms insert/dedup
        if ((json && (json.id || json.inserted)) || json?.deduped === true) {
          props.setProperty(STATE_LAST_ROW, String(rowIndex));
        } else {
          console.error("2xx but no id/inserted/deduped flag; pointer NOT advanced for row", rowIndex);
          break;
        }
      } catch (e) {
        console.error("2xx but non-JSON body for row", rowIndex, e);
        break;
      }
    } else {
      console.error("Webhook failed for row", rowIndex, code, text);
      break;
    }
  }
}

/** 🔬 One-shot tester */
function testWebhookOnce() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(WEBHOOK_URL_PROP);
  const secret = props.getProperty(WEBHOOK_SECRET_PROP);
  if (!url || !secret) throw new Error("Missing URL/SECRET. Run setupConfig().");

  const record = {
    name: "Webhook Test",
    email: "webhook.test@example.com",
    phone: "555-000-0000",
    state: "TN",
    notes: "Single test from Apps Script",
    created_at: new Date().toISOString(),
  };

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

  Logger.log("TEST status=%s body=%s", res.getResponseCode(), res.getContentText());
}

/** 🛠️ Helpers */
function showPointer() {
  const props = PropertiesService.getScriptProperties();
  const ptr = props.getProperty(STATE_LAST_ROW);
  Logger.log("Current LAST_POSTED_ROW = %s", ptr);
}

// Backfill: set pointer to header so next run posts everything after row 1.
function backfillAllNextRun() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(STATE_LAST_ROW, String(HEADER_ROW_INDEX));
  Logger.log("Backfill armed. Next run will post all rows after header.");
}

/** Convenience: reset pointer AND send one chunk immediately */
function backfillNow() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(STATE_LAST_POSTED_ROW, String(HEADER_ROW_INDEX)); // legacy key safeguard
  props.setProperty(STATE_LAST_ROW, String(HEADER_ROW_INDEX));
  Logger.log("Backfill armed (pointer reset). Sending first chunk now…");
  postNewRowsSinceLastPointer();
}

/** Set pointer to a specific row number (e.g., setPointerTo(100) → next run sends 101..end) */
function setPointerTo(rowNumber) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(STATE_LAST_ROW, String(rowNumber));
  Logger.log("Pointer set to row %s", rowNumber);
}

/** Utils */
function getTargetSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getActiveSheet();
  if (!sheet) throw new Error("Sheet not found. Set SHEET_NAME correctly or make your leads tab active.");
  return sheet;
}
`.trim();
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
        <li>Paste the script, then run <code>setupConfig()</code> once and authorize.</li>
        <li>Go to <em>Triggers</em> → add trigger for <code>onAnyChange</code> → “From spreadsheet / On change”.</li>
        <li>(Optional) Add a time trigger for <code>syncNewRows</code> every 1–5 minutes while backfilling.</li>
        <li>Add a test row — it’ll appear in your CRM automatically.</li>
      </ol>

      <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white">
        {scriptText}
      </pre>

      <p className="text-xs text-white/50">
        Tip: Use <code>backfillNow()</code> in Apps Script if you ever need to re-import everything,
        or <code>setPointerTo(n)</code> to resume from a specific row.
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