// File: src/pages/LeadsPage.jsx
import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  loadLeads, saveLeads,
  loadClients, saveClients,
  normalizePerson, upsert,
  loadLeadsApiKey, saveLeadsApiKey, clearLeadsApiKey,
} from "../lib/storage.js";

// NEW: add Supabase + our repo helper
import { supabase } from "../lib/supabaseClient.js";
import { repoMarkSold } from "../lib/leadsRepo.js";

// Optional existing automations – left intact
import {
  scheduleWelcomeText,
  schedulePolicyKickoffEmail
} from "../lib/automation.js";

// NEW: icons for API Key UI
import { Key, Eye, EyeOff, Trash2 } from "lucide-react";

const TEMPLATE_HEADERS = ["name","phone","email"]; // minimal CSV template

// ---- Header alias helpers ---------------------------------------------------
const H = {
  first: [
    "first","first name","firstname","given name","given_name","fname","first_name"
  ],
  last: [
    "last","last name","lastname","surname","family name","lname","last_name","family_name"
  ],
  full: [
    "name","full name","fullname","full_name"
  ],
  email: [
    "email","e-mail","email address","mail","email_address"
  ],
  phone: [
    "phone","phone number","mobile","cell","tel","telephone","number","phone_number"
  ],
  notes: [
    "notes","note","comments","comment","details"
  ],
  company: [
    "company","business","organization","organisation"
  ],
  // NEW fields
  dob: [
    "dob","date of birth","birthdate","birth date","d.o.b.","date"
  ],
  state: [
    "state","st","us state","residence state"
  ],
  beneficiary: [
    "beneficiary","beneficiary type"
  ],
  beneficiary_name: [
    "beneficiary name","beneficiary_name","beneficiary full name"
  ],
  gender: [
    "gender","sex"
  ],
};

const norm = (s) => (s || "").toString().trim().toLowerCase();

function buildHeaderIndex(headers) {
  const normalized = headers.map(norm);
  const find = (candidates) => {
    for (let i = 0; i < normalized.length; i++) {
      if (candidates.includes(normalized[i])) return headers[i]; // return original header
    }
    return null;
  };
  return {
    first:  find(H.first),
    last:   find(H.last),
    full:   find(H.full),
    email:  find(H.email),
    phone:  find(H.phone),
    notes:  find(H.notes),
    company:find(H.company),
    // NEW
    dob:    find(H.dob),
    state:  find(H.state),
    beneficiary: find(H.beneficiary),
    beneficiary_name: find(H.beneficiary_name),
    gender: find(H.gender),
  };
}

function pick(row, key) {
  if (!key) return "";
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

function buildName(row, map) {
  const full = pick(row, map.full);
  if (full) return full;
  const first = pick(row, map.first);
  const last  = pick(row, map.last);
  const combined = `${first} ${last}`.trim();
  if (combined) return combined;
  const company = pick(row, map.company);
  if (company) return company;
  const email = pick(row, map.email);
  if (email && email.includes("@")) return email.split("@")[0];
  return "";
}
const buildPhone = (row, map) =>
  pick(row, map.phone) || row.phone || row.number || "";
const buildEmail = (row, map) =>
  pick(row, map.email) || row.email || "";
const buildNotes = (row, map) => pick(row, map.notes) || "";

// NEW field builders (string passthrough)
const buildDob = (row, map) => pick(row, map.dob);
const buildState = (row, map) => (pick(row, map.state) || "").toUpperCase();
const buildBeneficiary = (row, map) => pick(row, map.beneficiary);
const buildBeneficiaryName = (row, map) => pick(row, map.beneficiary_name);
const buildGender = (row, map) => pick(row, map.gender);

export default function LeadsPage() {
  const [tab, setTab] = useState("clients"); // 'clients' | 'sold'
  const [leads, setLeads] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");

  // NEW: feedback
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  // NEW: API key modal state + handlers
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => loadLeadsApiKey());
  const [showKey, setShowKey] = useState(false);
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

  useEffect(() => {
    setLeads(loadLeads());
    setClients(loadClients());
  }, []);

  // Merge clients + leads into a deduped "Leads" view (formerly "Clients")
  const allClients = useMemo(() => {
    const map = new Map();
    for (const x of clients) map.set(x.id, x);
    for (const y of leads) if (!map.has(y.id)) map.set(y.id, y);
    return [...map.values()];
  }, [clients, leads]);

  const onlySold  = useMemo(() => allClients.filter(c => c.status === "sold"), [allClients]);

  const visible = useMemo(() => {
    const src = tab === "clients" ? allClients : onlySold;
    const q = filter.trim().toLowerCase();
    return q
      ? src.filter(r =>
          [r.name, r.email, r.phone, r.state, r.gender, r.beneficiary_name]
            .some(v => (v||"").toLowerCase().includes(q)))
      : src;
  }, [tab, allClients, onlySold, filter]);

  function handleImportCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const rows = res.data || [];
        if (!rows.length) {
          alert("CSV has no rows.");
          return;
        }
        const headers = Object.keys(rows[0] || {});
        const map = buildHeaderIndex(headers);

        const normalized = rows
          .map((r) => {
            const name  = r.name || r.Name || buildName(r, map);
            const phone = buildPhone(r, map);
            const email = buildEmail(r, map);
            const notes = buildNotes(r, map);

            // NEW fields
            const dob  = buildDob(r, map);
            const state = buildState(r, map);
            const beneficiary = buildBeneficiary(r, map);
            const beneficiary_name = buildBeneficiaryName(r, map);
            const gender = buildGender(r, map);

            return normalizePerson({
              name, phone, email, notes,
              status: "lead",
              dob, state, beneficiary, beneficiary_name, gender,
            });
          })
          .filter(r => r.name || r.phone || r.email);

        const newLeads = [...normalized, ...leads];
        const newClients = [...normalized, ...clients];
        saveLeads(newLeads);
        saveClients(newClients);
        setLeads(newLeads);
        setClients(newClients);
        setTab("clients");
      },
      error: (err) => alert("CSV parse error: " + err.message),
    });
  }

  function downloadTemplate() {
    const csv = Papa.unparse([Object.fromEntries(TEMPLATE_HEADERS.map(h => [h, ""]))], { header: true });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "remie_leads_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openAsSold(person) { setSelected(person); }

  // 🔧 REPLACED: now async, writes to local + Supabase, then enqueues mail job
  async function saveSoldInfo(id, soldPayload) {
    try {
      setBusy(true);
      setToast("");

      // 1) Update local state immediately (same behavior as before)
      let list = [...allClients];
      const idx = list.findIndex(x => x.id === id);
      const base = idx >= 0 ? list[idx] : normalizePerson({ id });

      const updated = {
        ...base,
        status: "sold",
        sold: {
          carrier: soldPayload.carrier || "",
          faceAmount: soldPayload.faceAmount || "",
          premium: soldPayload.premium || "",
          monthlyPayment: soldPayload.monthlyPayment || "",
          policyNumber: soldPayload.policyNumber || "", // keep policy number if provided later
          effectiveDate: soldPayload.startDate || soldPayload.effectiveDate || "",
          notes: soldPayload.notes || "",
          address: {
            street: soldPayload.street || "",
            city: soldPayload.city || "",
            state: soldPayload.state || "",
            zip: soldPayload.zip || "",
          }
        },
        name: soldPayload.name || base.name || "",
        phone: soldPayload.phone || base.phone || "",
        email: soldPayload.email || base.email || "",
      };

      const nextClients = upsert(clients, updated);
      const nextLeads   = upsert(leads, updated);
      saveClients(nextClients);
      saveLeads(nextLeads);
      setClients(nextClients);
      setLeads(nextLeads);

      // 2) Persist to Supabase (via repo helper)
      await repoMarkSold(id, updated.sold);

      // 3) Optional existing automations you had
      if (soldPayload.sendWelcomeText) {
        scheduleWelcomeText({
          name: updated.name,
          phone: updated.phone,
          carrier: updated.sold?.carrier,
          startDate: updated.sold?.effectiveDate || updated.sold?.startDate,
        });
      }
      if (soldPayload.sendPolicyEmailOrMail) {
        schedulePolicyKickoffEmail({
          name: updated.name,
          email: updated.email,
          carrier: updated.sold?.carrier,
          faceAmount: updated.sold?.faceAmount,
          monthlyPayment: updated.sold?.monthlyPayment,
          startDate: updated.sold?.effectiveDate || updated.sold?.startDate,
          address: updated.sold?.address,
        });
      }

      // 4) Enqueue Lob mailing job (server function) – requires logged-in user
      const { data: s } = await supabase.auth.getSession();
      const userId = s?.session?.user?.id;

      // Guardrails: only enqueue if we have enough address to mail
      const addr = updated.sold?.address || {};
      const hasMailAddr = addr.street && addr.city && addr.state && addr.zip;

      if (userId && hasMailAddr) {
        await fetch("/.netlify/functions/enqueue-mail-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            lead_id: id, // same UUID we store in Supabase
            type: "welcome_policy_letter",
            payload: {
              firstName: (updated.name || "").split(" ")[0] || "Customer",
              policyNumber: updated?.sold?.policyNumber || "",
            },
          }),
        }).catch(() => {});
        setToast("Saved as sold and enqueued mail job.");
      } else if (!userId) {
        setToast("Saved as sold locally; log in to enqueue mail job.");
      } else {
        setToast("Saved as sold; missing mailing address, not enqueued.");
      }

      setSelected(null);
      setTab("sold");
    } catch (e) {
      console.error(e);
      alert("Error saving SOLD: " + (e?.message || e));
    } finally {
      setBusy(false);
      // auto-hide toast
      if (toast) setTimeout(() => setToast(""), 3000);
    }
  }

  function removeOne(id) {
    if (!confirm("Delete this record? This only affects your local data.")) return;
    const nextClients = clients.filter(c => c.id !== id);
    const nextLeads   = leads.filter(l => l.id !== id);
    saveClients(nextClients);
    saveLeads(nextLeads);
    setClients(nextClients);
    setLeads(nextLeads);
    if (selected?.id === id) setSelected(null);
  }

  function removeAll() {
    if (!confirm("Clear ALL locally stored leads/clients?")) return;
    saveLeads([]);
    saveClients([]);
    setLeads([]);
    setClients([]);
    setSelected(null);
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-white/15 bg-white/5 p-1 text-sm">
          {[
            { id:"clients", label:"Leads" },   // renamed from Clients
            { id:"sold",    label:"Sold"  },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3 py-1 ${tab===t.id ? "bg-white text-black" : "text-white/80"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="ml-auto inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm cursor-pointer">
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

        <button
          onClick={downloadTemplate}
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm"
        >
          Download CSV template
        </button>

        <button
          onClick={removeAll}
          className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm"
        >
          Clear all (local)
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
          placeholder="Search by name, phone, email, state…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {busy && <span className="text-sm text-white/70">Saving…</span>}
        {!!toast && <span className="text-sm text-emerald-400">{toast}</span>}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-[1200px] w-full border-collapse text-sm">
          <thead className="bg-white/[0.04] text-white/70">
            <tr>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Email</Th>
              <Th>DOB</Th>
              <Th>State</Th>
              <Th>Beneficiary</Th>
              <Th>Beneficiary Name</Th>
              <Th>Gender</Th>
              <Th>Status</Th>
              <Th>Carrier</Th>
              <Th>Face</Th>
              <Th>Premium</Th>
              <Th>Monthly</Th>
              <Th>Start</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className="border-t border-white/10">
                <Td>{p.name || "—"}</Td>
                <Td>{p.phone || "—"}</Td>
                <Td>{p.email || "—"}</Td>
                <Td>{p.dob || "—"}</Td>
                <Td>{p.state || "—"}</Td>
                <Td>{p.beneficiary || "—"}</Td>
                <Td>{p.beneficiary_name || "—"}</Td>
                <Td>{p.gender || "—"}</Td>
                <Td>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    p.status === "sold" ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-white/80"
                  }`}>
                    {p.status}
                  </span>
                </Td>
                <Td>{p.sold?.carrier || "—"}</Td>
                <Td>{p.sold?.faceAmount || "—"}</Td>
                <Td>{p.sold?.premium || "—"}</Td>
                <Td>{p.sold?.monthlyPayment || "—"}</Td>
                <Td>{p.sold?.effectiveDate || p.sold?.startDate || "—"}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openAsSold(p)}
                      className="rounded-lg border border-white/15 px-2 py-1 hover:bg-white/10"
                    >
                      Mark as SOLD
                    </button>
                    <button
                      onClick={() => removeOne(p.id)}
                      className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 hover:bg-rose-500/20"
                      title="Delete this record (local only)"
                    >
                      Delete
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={15} className="p-6 text-center text-white/60">
                  No records yet. Import a CSV or add leads.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer for SOLD */}
      {selected && (
        <SoldDrawer
          initial={selected}
          allClients={allClients}
          onClose={() => setSelected(null)}
          onSave={(payload) => saveSoldInfo(payload.id, payload)}
        />
      )}

      {/* NEW: API Key Modal */}
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

          {/* minimal input style to match your page */}
          <style>{`.inp{width:100%; border-radius:0.75rem; border:1px solid rgba(255,255,255,.15); background:#0b0b0b; padding:.5rem .75rem; outline:none}
          .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
        </div>
      )}
    </div>
  );
}

function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-2">{children}</td>; }

function SoldDrawer({ initial, allClients, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial?.id || (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now())),
    name: initial?.name || "",
    phone: initial?.phone || "",
    email: initial?.email || "",
    carrier: initial?.sold?.carrier || "",
    faceAmount: initial?.sold?.faceAmount || "",
    premium: initial?.sold?.premium || "",
    monthlyPayment: initial?.sold?.monthlyPayment || "",
    startDate: initial?.sold?.startDate || "",
    // Address
    street: initial?.sold?.address?.street || "",
    city: initial?.sold?.address?.city || "",
    state: initial?.sold?.address?.state || "",
    zip: initial?.sold?.address?.zip || "",
    // Automations
    sendWelcomeText: true,
    sendPolicyEmailOrMail: true,
  });

  function pickClient(id) {
    const c = allClients.find(x => x.id === id);
    if (!c) return;
    setForm((f) => ({
      ...f,
      id: c.id,
      name: c.name || f.name,
      phone: c.phone || f.phone,
      email: c.email || f.email,
    }));
  }

  function submit(e) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="fixed inset-0 z-50 grid bg-black/60 p-4">
      <div className="relative m-auto w-full max-w-3xl rounded-2xl border border-white/15 bg-neutral-950 p-5">
        <div className="mb-3 text-lg font-semibold">Mark as SOLD</div>

        <div className="mb-3">
          <label className="text-sm text-white/70">Select existing lead (optional)</label>
          <select
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            onChange={(e) => e.target.value && pickClient(e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>Choose from Leads…</option>
            {allClients.map(c => (
              <option key={c.id} value={c.id}>
                {c.name || c.email || c.phone || c.id}
              </option>
            ))}
          </select>
          <div className="mt-1 text-xs text-white/50">Or type their info manually below.</div>
        </div>

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})}
                   className="inp" placeholder="Jane Doe" />
          </Field>
          <Field label="Phone">
            <input value={form.phone} onChange={(e)=>setForm({...form, phone:e.target.value})}
                   className="inp" placeholder="(555) 123-4567" />
          </Field>
          <Field label="Email">
            <input value={form.email} onChange={(e)=>setForm({...form, email:e.target.value})}
                   className="inp" placeholder="jane@example.com" />
          </Field>

        {/* sold fields */}
          <Field label="Carrier sold">
            <input value={form.carrier} onChange={(e)=>setForm({...form, carrier:e.target.value})}
                   className="inp" placeholder="Mutual of Omaha" />
          </Field>
          <Field label="Face amount">
            <input value={form.faceAmount} onChange={(e)=>setForm({...form, faceAmount:e.target.value})}
                   className="inp" placeholder="250,000" />
          </Field>
          <Field label="Premium sold">
            <input value={form.premium} onChange={(e)=>setForm({...form, premium:e.target.value})}
                   className="inp" placeholder="3,000" />
          </Field>
          <Field label="Monthly payment">
            <input value={form.monthlyPayment} onChange={(e)=>setForm({...form, monthlyPayment:e.target.value})}
                   className="inp" placeholder="250" />
          </Field>
          <Field label="Policy start date">
            <input type="date" value={form.startDate} onChange={(e)=>setForm({...form, startDate:e.target.value})}
                   className="inp" />
          </Field>

          <Field label="Street">
            <input value={form.street} onChange={(e)=>setForm({...form, street:e.target.value})}
                   className="inp" placeholder="123 Main St" />
          </Field>
          <Field label="City">
            <input value={form.city} onChange={(e)=>setForm({...form, city:e.target.value})}
                   className="inp" placeholder="Austin" />
          </Field>
          <Field label="State">
            <input value={form.state} onChange={(e)=>setForm({...form, state:e.target.value})}
                   className="inp" placeholder="TX" />
          </Field>
          <Field label="ZIP">
            <input value={form.zip} onChange={(e)=>setForm({...form, zip:e.target.value})}
                   className="inp" placeholder="78701" />
          </Field>

          <div className="sm:col-span-2 mt-1 grid gap-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sendWelcomeText}
                onChange={(e)=>setForm({...form, sendWelcomeText:e.target.checked})}
              />
              Send welcome text after saving
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sendPolicyEmailOrMail}
                onChange={(e)=>setForm({...form, sendPolicyEmailOrMail:e.target.checked})}
              />
              Send policy kickoff email / printable letter after saving
            </label>
            <div className="text-xs text-white/50">
              (Emails require an email address. Printable letters use the mailing address.)
            </div>
          </div>

          <div className="sm:col-span-2 mt-2 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10">
              Cancel
            </button>
            <button type="submit"
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90">
              Save as SOLD
            </button>
          </div>
        </form>
      </div>
      <style>{`.inp{width:100%; border-radius:0.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.5rem .75rem; outline:none}
        .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="text-sm">
      <div className="mb-1 text-white/70">{label}</div>
      {children}
    </label>
  );
}
