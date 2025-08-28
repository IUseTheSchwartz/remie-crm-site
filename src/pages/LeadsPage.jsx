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

const TEMPLATE_HEADERS = ["name","phone","email"]; // minimum CSV headers

export default function LeadsPage() {
  const [tab, setTab] = useState("clients"); // 'clients' | 'leads' | 'sold'
  const [leads, setLeads] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setLeads(loadLeads());
    setClients(loadClients());
  }, []);

  // Merge clients + leads into a deduped "clients" view
  const allClients = useMemo(() => {
    const map = new Map();
    for (const x of clients) map.set(x.id, x);
    for (const y of leads) if (!map.has(y.id)) map.set(y.id, y);
    return [...map.values()];
  }, [clients, leads]);

  const onlyLeads = useMemo(() => allClients.filter(c => c.status === "lead"), [allClients]);
  const onlySold  = useMemo(() => allClients.filter(c => c.status === "sold"), [allClients]);

  const visible = useMemo(() => {
    const src = tab === "clients" ? allClients : tab === "leads" ? onlyLeads : onlySold;
    const q = filter.trim().toLowerCase();
    return q
      ? src.filter(r =>
          [r.name, r.email, r.phone].some(v => (v||"").toLowerCase().includes(q)))
      : src;
  }, [tab, allClients, onlyLeads, onlySold, filter]);

  function handleImportCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data;
        const normalized = rows
          .map(r => normalizePerson({
            name: r.name || r.Name,
            phone: r.phone || r.number || r.Phone || r.Number,
            email: r.email || r.Email,
            status: "lead",
          }))
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

  function saveSoldInfo(id, soldPayload) {
    // Update / upsert record and mark as SOLD
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
        startDate: soldPayload.startDate || "",
        name: soldPayload.name || base.name || "",
        phone: soldPayload.phone || base.phone || "",
        email: soldPayload.email || base.email || "",
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

    // Persist
    const nextClients = upsert(clients, updated);
    const nextLeads   = upsert(leads, updated);
    saveClients(nextClients);
    saveLeads(nextLeads);
    setClients(nextClients);
    setLeads(nextLeads);

    // OPTIONAL: queue automations when toggled
    if (soldPayload.sendWelcomeText) {
      scheduleWelcomeText({
        name: updated.name,
        phone: updated.phone,
        carrier: updated.sold?.carrier,
        startDate: updated.sold?.startDate,
      });
    }
    if (soldPayload.sendPolicyEmailOrMail) {
      schedulePolicyKickoffEmail({
        name: updated.name,
        email: updated.email,
        carrier: updated.sold?.carrier,
        faceAmount: updated.sold?.faceAmount,
        monthlyPayment: updated.sold?.monthlyPayment,
        startDate: updated.sold?.startDate,
        address: updated.sold?.address,
      });
    }

    setSelected(null);
    setTab("sold");
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
            { id:"clients", label:"Clients" },
            { id:"leads",   label:"Leads" },
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
          placeholder="Search by name, phone, or email…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-[920px] w-full border-collapse text-sm">
          <thead className="bg-white/[0.04] text-white/70">
            <tr>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Email</Th>
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
                <Td>{p.sold?.startDate || "—"}</Td>
                <Td>
                  <button
                    onClick={() => openAsSold(p)}
                    className="rounded-lg border border-white/15 px-2 py-1 hover:bg-white/10"
                  >
                    Mark as SOLD
                  </button>
                </Td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-white/60">
                  No records yet. Import a CSV or add leads to your Clients list.
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
    </div>
  );
}

function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children }) { return <td className="px-3 py-2">{children}</td>; }

function SoldDrawer({ initial, allClients, onClose, onSave }) {
  const [form, setForm] = useState({
    id: initial?.id || crypto.randomUUID(),
    name: initial?.name || "",
    phone: initial?.phone || "",
    email: initial?.email || "",
    carrier: initial?.sold?.carrier || "",
    faceAmount: initial?.sold?.faceAmount || "",
    premium: initial?.sold?.premium || "",
    monthlyPayment: initial?.sold?.monthlyPayment || "",
    startDate: initial?.sold?.startDate || "",
    // NEW address fields
    street: initial?.sold?.address?.street || "",
    city: initial?.sold?.address?.city || "",
    state: initial?.sold?.address?.state || "",
    zip: initial?.sold?.address?.zip || "",
    // NEW automation toggles
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

        {/* Select existing client to pre-fill */}
        <div className="mb-3">
          <label className="text-sm text-white/70">Select existing client (optional)</label>
          <select
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
            onChange={(e) => e.target.value && pickClient(e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>Choose from Clients…</option>
            {allClients.map(c => (
              <option key={c.id} value={c.id}>
                {c.name || c.email || c.phone || c.id}
              </option>
            ))}
          </select>
          <div className="mt-1 text-xs text-white/50">Or type their info manually below.</div>
        </div>

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          {/* Identity */}
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

          {/* Sale details */}
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

          {/* Address (NEW) */}
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

          {/* Automations (NEW) */}
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
