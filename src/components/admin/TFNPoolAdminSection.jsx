// File: src/components/admin/TFNPoolAdminSection.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  Loader2, Plus, RefreshCw, CheckCircle2, XCircle, Trash2, Unlock, UserPlus, Search,
} from "lucide-react";

/* small helpers */
function fmtE164(s) {
  const m = String(s||"").match(/^\+1?(\d{10})$/);
  if (!m) return s||"";
  const d = m[1];
  return `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
const TFN_REGEX = /^\+18(00|88|77|66|55|44|33)\d{7}$/;

export default function TFNPoolAdminSection() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // add form
  const [form, setForm] = useState({ phone_number: "", telnyx_number_id: "", verified: true });

  // quick filters/search
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | available | assigned | unverified

  const filtered = useMemo(() => {
    let list = rows;
    if (filter === "available") list = list.filter(r => !r.assigned_to);
    if (filter === "assigned") list = list.filter(r => !!r.assigned_to);
    if (filter === "unverified") list = list.filter(r => !r.verified);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter(r =>
        (r.phone_number||"").toLowerCase().includes(s) ||
        (r.telnyx_number_id||"").toLowerCase().includes(s) ||
        (r.assigned_to||"").toLowerCase().includes(s)
      );
    }
    return list;
  }, [rows, q, filter]);

  async function load() {
    setLoading(true);
    setMsg("");
    const { data, error } = await supabase
      .from("toll_free_numbers")
      .select("id, phone_number, telnyx_number_id, verified, assigned_to, date_assigned, created_at")
      .order("created_at", { ascending: false });
    if (error) setMsg(error.message);
    setRows(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function addNumber(e) {
    e?.preventDefault?.();
    setMsg("");
    const phone = form.phone_number.trim();
    if (!TFN_REGEX.test(phone)) {
      setMsg("Phone must be toll-free in E.164, e.g. +18885551234");
      return;
    }
    setSaving(true);
    const payload = {
      phone_number: phone,
      telnyx_number_id: form.telnyx_number_id?.trim() || null,
      verified: !!form.verified,
    };
    const { error } = await supabase.from("toll_free_numbers").insert(payload);
    if (error) setMsg(error.message); else setForm({ phone_number: "", telnyx_number_id: "", verified: true });
    setSaving(false);
    load();
  }

  async function toggleVerified(row) {
    setSaving(true);
    const { error } = await supabase
      .from("toll_free_numbers")
      .update({ verified: !row.verified })
      .eq("id", row.id);
    if (error) setMsg(error.message);
    setSaving(false);
    load();
  }

  async function release(row) {
    setSaving(true);
    const { error } = await supabase
      .from("toll_free_numbers")
      .update({ assigned_to: null, date_assigned: null })
      .eq("id", row.id);
    if (error) setMsg(error.message);
    setSaving(false);
    load();
  }

  async function deleteRow(row) {
    if (!window.confirm(`Delete ${row.phone_number}? This cannot be undone.`)) return;
    setSaving(true);
    const { error } = await supabase.from("toll_free_numbers").delete().eq("id", row.id);
    if (error) setMsg(error.message);
    setSaving(false);
    load();
  }

  // Assign to a user (by email or user_id uuid)
  const [assignTarget, setAssignTarget] = useState({ id: null, emailOrId: "" });
  async function assign(row) {
    const key = assignTarget.emailOrId.trim();
    if (!key) return setMsg("Enter an email or user_id (uuid).");

    setSaving(true);
    setMsg("");

    let userId = null;
    if (/^[0-9a-f-]{36}$/i.test(key)) {
      userId = key; // looks like uuid
    } else {
      // look up by email in agent_profiles first (fast), fallback to auth via RPC if you have one
      const { data: prof } = await supabase
        .from("agent_profiles")
        .select("user_id")
        .ilike("email", key)
        .limit(1)
        .maybeSingle();
      userId = prof?.user_id || null;
    }

    if (!userId) {
      setSaving(false);
      setMsg("Could not find user by that email/id.");
      return;
    }

    const { error } = await supabase
      .from("toll_free_numbers")
      .update({ assigned_to: userId, date_assigned: new Date().toISOString() })
      .eq("id", row.id);
    if (error) setMsg(error.message);
    setSaving(false);
    setAssignTarget({ id: null, emailOrId: "" });
    load();
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Toll-Free Number Pool</h2>
          <p className="text-xs text-white/60">Add verified TFNs, assign to users, or release numbers back to the pool.</p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </header>

      {msg && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-sm text-amber-200">
          {msg}
        </div>
      )}

      {/* Add new row */}
      <form onSubmit={addNumber} className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:grid-cols-4">
        <label className="text-xs text-white/70">
          Phone number (E.164)
          <input
            className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
            placeholder="+18885551234"
            value={form.phone_number}
            onChange={(e) => setForm(f => ({ ...f, phone_number: e.target.value }))}
            required
          />
        </label>
        <label className="text-xs text-white/70">
          Telnyx number id (optional)
          <input
            className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
            placeholder="PN_xxx…"
            value={form.telnyx_number_id}
            onChange={(e) => setForm(f => ({ ...f, telnyx_number_id: e.target.value }))}
          />
        </label>
        <label className="text-xs text-white/70 flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.verified}
            onChange={(e) => setForm(f => ({ ...f, verified: e.target.checked }))}
          />
          <span>Verified</span>
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add number
          </button>
        </div>
      </form>

      {/* Filters / search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-white/10">
          {["all","available","assigned","unverified"].map(k => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 text-sm ${filter===k ? "bg-white/15" : "bg-white/5 hover:bg-white/10"}`}
            >
              {k[0].toUpperCase()+k.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-white/40" />
          <input
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            placeholder="Search number, Telnyx ID, or user_id"
            className="rounded-lg border border-white/15 bg-white/5 pl-8 pr-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-white/10">
        {loading ? (
          <div className="p-4 text-sm text-white/70">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Loading pool…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-sm text-white/60">No numbers match.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-white/5 text-white/70">
                <tr>
                  <th className="px-3 py-2 text-left">Number</th>
                  <th className="px-3 py-2 text-left">Telnyx ID</th>
                  <th className="px-3 py-2 text-left">Verified</th>
                  <th className="px-3 py-2 text-left">Assigned To</th>
                  <th className="px-3 py-2 text-left">Assigned At</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 bg-black/20">
                {filtered.map(r => (
                  <tr key={r.id} className="hover:bg-white/5">
                    <td className="px-3 py-2 font-mono">{fmtE164(r.phone_number)}</td>
                    <td className="px-3 py-2">{r.telnyx_number_id || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${r.verified ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-200"}`}>
                        {r.verified ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                        {r.verified ? "Verified" : "Pending"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.assigned_to ? (
                        <span className="text-white/80">{r.assigned_to}</span>
                      ) : (
                        <span className="text-white/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.date_assigned ? new Date(r.date_assigned).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => toggleVerified(r)}
                          className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                        >
                          Toggle verified
                        </button>

                        {r.assigned_to ? (
                          <button
                            onClick={() => release(r)}
                            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                            title="Unassign, return to pool"
                          >
                            <Unlock className="h-3.5 w-3.5" /> Release
                          </button>
                        ) : (
                          <div className="flex items-center gap-1">
                            <input
                              value={assignTarget.id === r.id ? assignTarget.emailOrId : ""}
                              onChange={(e)=>setAssignTarget({ id: r.id, emailOrId: e.target.value })}
                              placeholder="email or user_id"
                              className="w-40 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-indigo-400/40"
                            />
                            <button
                              onClick={() => assign(r)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                              title="Assign to user"
                            >
                              <UserPlus className="h-3.5 w-3.5" /> Assign
                            </button>
                          </div>
                        )}

                        <button
                          onClick={() => deleteRow(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                          title="Delete record"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-white/50">
        Tip: mark only truly approved TFNs as <b>Verified</b>. The Messaging Settings “Get My Number” button selects
        <code> verified = true AND assigned_to IS NULL</code>.
      </p>
    </section>
  );
}
