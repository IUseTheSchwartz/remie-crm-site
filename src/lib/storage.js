// File: src/pages/LeadsPage.jsx
import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  loadLeads, saveLeads,
  loadClients, saveClients,
  normalizePerson, upsert
} from "../lib/storage.js";

import {
  scheduleWelcomeText,
  schedulePolicyKickoffEmail
} from "../lib/automation.js";

// NEW: API key helpers
import {
  loadLeadsApiKey,
  saveLeadsApiKey,
  clearLeadsApiKey,
} from "../lib/storage.js";

// Icons (lucide-react) are already used in your app, optional
import { Key, Eye, EyeOff, Trash2 } from "lucide-react";

/* ---------------------------
   CSV -> fields map & helpers
----------------------------*/
const HEADERS = {
  full: ["name", "full name", "fullname"],
  first: ["first", "first name", "firstname", "given name"],
  last: ["last", "last name", "lastname", "surname", "family name"],
  email: ["email", "e-mail", "mail"],
  phone: [
    "phone","phone number","mobile","cell","tel","telephone","number","phone_number"
  ],
  notes: ["notes","note","comments","comment","details"],
  company: ["company","business","organization","organisation"],
  // NEW fields
  dob: ["dob","date of birth","birthdate","birth date","d.o.b.","date"],
  state: ["state","us state","residence state"],
  beneficiary: ["beneficiary","beneficiary type"],
  beneficiary_name: ["beneficiary name","beneficiary_name","beneficiary full name"],
  gender: ["gender","sex"],
};

const norm = (s) => (s || "").toString().trim().toLowerCase();

function buildHeaderIndex(headers) {
  const H = {};
  for (const [key, list] of Object.entries(HEADERS)) {
    const found = list
      .map((v) => headers.findIndex((h) => norm(h) === norm(v)))
      .find((idx) => idx >= 0);
    H[key] = found ?? -1;
  }
  return H;
}
function headerMap(H) {
  const find = (key) => (H[key] >= 0 ? H[key] : null);
  return {
    full: find("full"),
    first: find("first"),
    last: find("last"),
    email: find("email"),
    phone: find("phone"),
    notes: find("notes"),
    company: find("company"),
    dob: find("dob"),
    state: find("state"),
    beneficiary: find("beneficiary"),
    beneficiary_name: find("beneficiary_name"),
    gender: find("gender"),
  };
}
function pick(row, key) {
  if (!key && key !== 0) return "";
  const v = row[key];
  return v == null ? "" : String(v).trim();
}
function buildName(row, map) {
  const full = pick(row, map.full);
  if (full) return full;
  const first = pick(row, map.first);
  const last = pick(row, map.last);
  return [first, last].filter(Boolean).join(" ").trim();
}

/* ---------------------------
   Page
----------------------------*/
export default function LeadsPage() {
  const [leads, setLeads] = useState(() => loadLeads());
  const [clients, setClients] = useState(() => loadClients());

  // NEW: API key modal state
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => loadLeadsApiKey());
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    saveLeads(leads);
  }, [leads]);

  useEffect(() => {
    saveClients(clients);
  }, [clients]);

  /* -------------- CSV import -------------- */
  function handleImportCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data || [];
        const headers = results.meta?.fields || [];
        const H = buildHeaderIndex(headers);
        const M = headerMap(H);

        const imported = rows.map((row) =>
          normalizePerson({
            name: buildName(row, M),
            email: pick(row, M.email),
            phone: pick(row, M.phone),
            notes: pick(row, M.notes),
            company: pick(row, M.company),
            dob: pick(row, M.dob),
            state: pick(row, M.state),
            beneficiary: pick(row, M.beneficiary),
            beneficiary_name: pick(row, M.beneficiary_name),
            gender: pick(row, M.gender),
          })
        );

        setLeads((prev) => {
          let next = [...prev];
          for (const p of imported) next = upsert(next, p);
          return next;
        });
      },
      error: (err) => {
        console.error("CSV parse error:", err);
        alert("Failed to parse CSV. Please check your file.");
      },
    });
  }

  function downloadTemplate() {
    const headers = [
      "Full Name","First","Last","Email","Phone","Notes","Company",
      "DOB","State","Beneficiary","Beneficiary Name","Gender"
    ];
    const csv = [headers.join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Save API key on modal save
  function handleSaveApiKey() {
    saveLeadsApiKey(apiKey);
    setApiKeyOpen(false);
  }
  function handleClearApiKey() {
    if (!confirm("Remove the saved API key?")) return;
    clearLeadsApiKey();
    setApiKey("");
    setShowKey(false);
  }

  /* -------------- UI -------------- */
  return (
    <div className="mx-auto max-w-6xl p-4 text-white">
      <h1 className="mb-4 text-2xl font-semibold">Leads</h1>

      {/* Top actions */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {/* Import CSV */}
        <label className="cursor-pointer rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm">
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleImportCsv(e.target.files[0])}
          />
          Import CSV
        </label>

        {/* NEW: Add API Key button */}
        <button
          onClick={() => setApiKeyOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
          title="Set API key for lead auto-import"
        >
          <Key size={16} />
          Add API Key
        </button>

        {/* Template download */}
        <button
          onClick={downloadTemplate}
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
        >
          Download CSV Template
        </button>
      </div>

      {/* ... your existing leads table / form UI continues below ... */}

      {/* ===== API Key Modal (NEW) ===== */}
      {apiKeyOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-900 p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Lead Vendor API Key</h2>
            </div>

            <p className="mb-3 text-sm text-white/70">
              Paste your lead vendor API key. We’ll store it locally for auto-import.
            </p>

            <div className="mb-3">
              <label className="mb-1 block text-sm text-white/70">API Key</label>
              <div className="flex items-center gap-2">
                <input
                  type={showKey ? "text" : "password"}
                  className="inp flex-1"
                  placeholder="sk_live_..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  onClick={() => setShowKey((s) => !s)}
                  className="rounded-xl border border-white/15 bg-white/5 px-2 py-2"
                  title={showKey ? "Hide" : "Show"}
                >
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                {apiKey && (
                  <button
                    onClick={handleClearApiKey}
                    className="rounded-xl border border-white/15 bg-white/5 px-2 py-2"
                    title="Clear saved key"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {!!loadLeadsApiKey() && (
                <p className="mt-2 text-xs text-emerald-400">
                  A key is currently saved {showKey ? `(visible)` : `(hidden)`}.
                </p>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setApiKeyOpen(false)}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveApiKey}
                className="rounded-xl bg-indigo-600 px-3 py-2 text-sm"
              >
                Save Key
              </button>
            </div>
          </div>

          {/* minimal input style to match your existing page */}
          <style>{`.inp{width:100%; border-radius:0.75rem; border:1px solid rgba(255,255,255,.15); background:#0b0b0b; padding:.5rem .75rem; outline:none}
          .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
        </div>
      )}

      {/* Keep the rest of your existing LeadsPage content/render below */}
    </div>
  );
}

/* NOTE:
   This only saves/reads the API key locally for now.
   When you’re ready, we can swap to Supabase Row Level Security (user-scoped),
   and wire your vendor’s webhook to a Netlify function that upserts leads
   using this key for validation.
*/
