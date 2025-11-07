import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { toE164 } from "../../lib/phone.js";

const TABLE = "numbers_10dlc";

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-3 items-center gap-3 py-2">
      <div className="text-sm text-white/70">{label}</div>
      <div className="col-span-2">{children}</div>
    </div>
  );
}

export default function NumberPool10DLC() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const [agents, setAgents] = useState([]);
  const [numbers, setNumbers] = useState([]);

  // add form
  const [phone, setPhone] = useState("");
  const [telnyxId, setTelnyxId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [notes, setNotes] = useState("");

  async function loadAll() {
    setLoading(true);
    setErr("");
    try {
      // Numbers
      const { data: nums, error: nErr } = await supabase
        .from(TABLE)
        .select("id, phone_number, telnyx_number_id, brand_id, campaign_id, assigned_to, date_assigned, notes, active")
        .order("created_at", { ascending: false });
      if (nErr) throw nErr;

      // Agents list (for human-friendly assignment)
      const { data: profs, error: pErr } = await supabase
        .from("agent_profiles")
        .select("user_id, email, full_name")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (pErr) throw pErr;

      setNumbers(nums || []);
      setAgents(profs || []);
    } catch (e) {
      // Nice message if table doesn’t exist yet
      if (String(e?.message || "").includes(`relation "${TABLE}" does not exist`) || e?.code === "42P01") {
        setErr(
          `The ${TABLE} table was not found. Create it in Supabase first.`
        );
      } else {
        setErr(e.message || "Failed to load 10DLC pool");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const agentById = useMemo(() => {
    const m = new Map();
    agents.forEach(a => m.set(a.user_id, a));
    return m;
  }, [agents]);

  async function addNumber() {
    setSaving(true);
    setErr("");
    try {
      const e164 = toE164(phone);
      if (!e164) throw new Error("Enter a valid US phone number");

      const payload = {
        phone_number: e164,
        telnyx_number_id: telnyxId || null,
        brand_id: brandId || null,
        campaign_id: campaignId || null,
        notes: notes || null,
        active: true,
      };

      const { error } = await supabase.from(TABLE).insert(payload).single();
      if (error) throw error;

      setPhone("");
      setTelnyxId("");
      setBrandId("");
      setCampaignId("");
      setNotes("");
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to add number");
    } finally {
      setSaving(false);
    }
  }

  async function assignNumber(id, userId) {
    setSaving(true);
    setErr("");
    try {
      if (!userId) throw new Error("Pick a user to assign");
      const { error } = await supabase
        .from(TABLE)
        .update({ assigned_to: userId, date_assigned: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to assign number");
    } finally {
      setSaving(false);
    }
  }

  async function unassignNumber(id) {
    setSaving(true);
    setErr("");
    try {
      const { error } = await supabase
        .from(TABLE)
        .update({ assigned_to: null, date_assigned: null })
        .eq("id", id);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to unassign number");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(id, active) {
    setSaving(true);
    setErr("");
    try {
      const { error } = await supabase.from(TABLE).update({ active: !!active }).eq("id", id);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to update status");
    } finally {
      setSaving(false);
    }
  }

  async function deleteNumber(id) {
    if (!confirm("Delete this number from the pool?")) return;
    setSaving(true);
    setErr("");
    try {
      const { error } = await supabase.from(TABLE).delete().eq("id", id);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to delete number");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-medium">10DLC Number Pool</div>
        <button
          onClick={loadAll}
          disabled={loading}
          className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Add number */}
      <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="text-sm font-medium mb-2">Add a 10DLC Number</div>
        <Row label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 555-5555"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
          />
        </Row>
        <Row label="Telnyx Number ID">
          <input
            value={telnyxId}
            onChange={(e) => setTelnyxId(e.target.value)}
            placeholder="ex: 129876543210987654"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
          />
        </Row>
        <Row label="Brand ID (10DLC)">
          <input
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            placeholder="Brand ID"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
          />
        </Row>
        <Row label="Campaign ID (10DLC)">
          <input
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            placeholder="Campaign ID"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
          />
        </Row>
        <Row label="Notes">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
          />
        </Row>

        <div className="flex justify-end">
          <button
            onClick={addNumber}
            disabled={saving}
            className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
          >
            {saving ? "Adding…" : "Add Number"}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left text-white/70">Number</th>
              <th className="px-3 py-2 text-left text-white/70">Telnyx ID</th>
              <th className="px-3 py-2 text-left text-white/70">Brand</th>
              <th className="px-3 py-2 text-left text-white/70">Campaign</th>
              <th className="px-3 py-2 text-left text-white/70">Assigned To</th>
              <th className="px-3 py-2 text-left text-white/70">Assigned On</th>
              <th className="px-3 py-2 text-left text-white/70">Active</th>
              <th className="px-3 py-2 text-left text-white/70">Notes</th>
              <th className="px-3 py-2 text-left text-white/70">Actions</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => {
              const agent = n.assigned_to ? agentById.get(n.assigned_to) : null;
              const assignedLabel = agent
                ? `${agent.full_name || agent.email || n.assigned_to}`
                : n.assigned_to
                ? n.assigned_to
                : "—";
              const date = n.date_assigned ? new Date(n.date_assigned).toLocaleString() : "—";

              return (
                <tr key={n.id} className="border-t border-white/10">
                  <td className="px-3 py-2">{n.phone_number}</td>
                  <td className="px-3 py-2 text-white/70">{n.telnyx_number_id || "—"}</td>
                  <td className="px-3 py-2 text-white/70">{n.brand_id || "—"}</td>
                  <td className="px-3 py-2 text-white/70">{n.campaign_id || "—"}</td>
                  <td className="px-3 py-2">{assignedLabel}</td>
                  <td className="px-3 py-2 text-white/60">{date}</td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!n.active}
                        onChange={(e) => toggleActive(n.id, e.target.checked)}
                      />
                      <span className="text-white/80">{n.active ? "Yes" : "No"}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2 max-w-[280px]">
                    <div title={n.notes || ""} className="truncate">{n.notes || "—"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <AssignDropdown
                        agents={agents}
                        onAssign={(userId) => assignNumber(n.id, userId)}
                        disabled={saving}
                      />
                      {n.assigned_to ? (
                        <button
                          onClick={() => unassignNumber(n.id)}
                          className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
                          disabled={saving}
                        >
                          Unassign
                        </button>
                      ) : null}
                      <button
                        onClick={() => deleteNumber(n.id)}
                        className="rounded-md border border-rose-400/30 px-2 py-1 text-xs hover:bg-rose-500/10"
                        disabled={saving}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {numbers.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={9}>
                  No numbers yet. Add your first 10DLC number above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-white/45">
        Assigning a number sets <code>assigned_to</code> and <code>date_assigned</code>. Messaging code
        should pull a user’s default 10DLC number from this table (preferring assigned numbers).
      </p>
    </div>
  );
}

function AssignDropdown({ agents, onAssign, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return agents.slice(0, 25);
    return agents.filter(a =>
      (a.email || "").toLowerCase().includes(q) ||
      (a.full_name || "").toLowerCase().includes(q)
    ).slice(0, 25);
  }, [agents, query]);

  return (
    <div className="relative">
      <button
        className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
      >
        Assign
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 rounded-lg border border-white/15 bg-black/90 p-2 shadow-xl">
          <input
            className="mb-2 w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs outline-none"
            placeholder="Search name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="max-h-64 overflow-auto">
            {filtered.map(a => (
              <button
                key={a.user_id}
                onClick={() => { onAssign(a.user_id); setOpen(false); }}
                className="block w-full rounded-md px-2 py-1 text-left text-xs hover:bg-white/10"
              >
                <div className="font-medium">{a.full_name || "—"}</div>
                <div className="text-white/60">{a.email || a.user_id}</div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-1 text-xs text-white/60">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
