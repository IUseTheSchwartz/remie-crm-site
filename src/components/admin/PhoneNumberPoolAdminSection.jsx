import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

/**
 * Unified Phone Number Pool (10DLC + Toll-free)
 *
 * Requires Supabase table `phone_numbers` with at least:
 *  - id (uuid) PK
 *  - e164 (text, unique, required)         e.g. +16155551234
 *  - type (text)                            '10dlc' | 'toll_free'
 *  - provider (text)                        'telnyx'
 *  - telnyx_number_id (text, nullable)
 *  - messaging_profile_id (text, nullable)  (should match your ENV profile typically)
 *  - campaign_id (text, nullable)           (required for type='10dlc')
 *  - area_code (int, nullable)
 *  - capabilities_sms (bool, default true)
 *  - capabilities_voice (bool, default true)
 *  - status (text, default 'active')        'active' | 'suspended' | 'released'
 *  - assigned_user_id (uuid, nullable)
 *  - assigned_team_id (uuid, nullable)
 *  - label (text, nullable)
 *  - created_at (timestamptz, default now())
 *  - updated_at (timestamptz)
 */

const TYPES = ["all", "10dlc", "toll_free"];
const STATUSES = ["all", "active", "suspended", "released"];
const ASSIGN = ["all", "assigned", "unassigned"];

export default function PhoneNumberPoolAdminSection() {
  const [loading, setLoading] = useState(false);
  const [savingMap, setSavingMap] = useState({});
  const [err, setErr] = useState("");

  const [rows, setRows] = useState([]);

  // filters
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [assignFilter, setAssignFilter] = useState("all");
  const [q, setQ] = useState("");

  // options for assignment
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);

  // add modal
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    e164: "",
    type: "10dlc",
    campaign_id: "",
    messaging_profile_id: "",
    label: "",
    capabilities_sms: true,
    capabilities_voice: true,
    status: "active",
  });

  function setSaving(id, v) {
    setSavingMap((m) => ({ ...m, [id]: v }));
  }

  async function loadAll() {
    setLoading(true);
    setErr("");
    try {
      const { data: nums, error: nErr } = await supabase
        .from("phone_numbers")
        .select("*")
        .order("created_at", { ascending: false });
      if (nErr) throw nErr;
      setRows(nums || []);

      const { data: profs, error: pErr } = await supabase
        .from("agent_profiles")
        .select("user_id, full_name, email")
        .order("full_name", { ascending: true });
      if (pErr) throw pErr;
      setUsers(profs || []);

      const { data: tms, error: tErr } = await supabase
        .from("teams")
        .select("id")
        .order("id", { ascending: true });
      if (tErr) throw tErr;
      setTeams(tms || []);
    } catch (e) {
      setErr(e.message || "Failed to load numbers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    return (rows || [])
      .filter((r) => (typeFilter === "all" ? true : r.type === typeFilter))
      .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter))
      .filter((r) =>
        assignFilter === "all"
          ? true
          : assignFilter === "assigned"
          ? !!(r.assigned_user_id || r.assigned_team_id)
          : !(r.assigned_user_id || r.assigned_team_id)
      )
      .filter((r) => {
        const hay = `${r.e164} ${r.label || ""} ${r.type} ${r.status} ${r.campaign_id || ""}`.toLowerCase();
        return hay.includes(q.toLowerCase());
      });
  }, [rows, typeFilter, statusFilter, assignFilter, q]);

  function areaCodeFromE164(e164) {
    const digits = String(e164 || "").replace(/\D/g, "");
    if (digits.length >= 11 && digits[0] === "1") {
      return Number(digits.slice(1, 4));
    }
    if (digits.length >= 10) return Number(digits.slice(0, 3));
    return null;
  }

  async function addNumber() {
    try {
      const { e164, type, campaign_id, messaging_profile_id, label, capabilities_sms, capabilities_voice, status } = addForm;

      if (!/^\+\d{10,15}$/.test(e164)) throw new Error("Enter a valid E.164 number like +16155551234");
      if (!["10dlc", "toll_free"].includes(type)) throw new Error("Type must be 10dlc or toll_free");
      if (type === "10dlc" && !campaign_id) throw new Error("10DLC numbers require a campaign_id");
      if (type === "toll_free" && !/^\+18|^\+17|^\+18/.test(e164)) {
        // not strictly needed; you may relax this
      }

      const now = new Date().toISOString();
      const ac = areaCodeFromE164(e164);

      const payload = {
        e164,
        type,
        provider: "telnyx",
        messaging_profile_id: messaging_profile_id || null,
        campaign_id: type === "10dlc" ? campaign_id : null,
        area_code: ac,
        capabilities_sms: !!capabilities_sms,
        capabilities_voice: !!capabilities_voice,
        status: status || "active",
        updated_at: now,
      };

      const { error } = await supabase.from("phone_numbers").insert([payload]);
      if (error) throw error;

      setShowAdd(false);
      setAddForm({
        e164: "",
        type: "10dlc",
        campaign_id: "",
        messaging_profile_id: "",
        label: "",
        capabilities_sms: true,
        capabilities_voice: true,
        status: "active",
      });
      await loadAll();
    } catch (e) {
      alert(e.message || "Failed to add number");
    }
  }

  async function saveRow(row) {
    setSaving(row.id, true);
    setErr("");
    try {
      if (!/^\+\d{10,15}$/.test(row.e164)) throw new Error("Invalid E.164 format");
      if (row.type === "10dlc" && !row.campaign_id) throw new Error("10DLC numbers require campaign_id");
      const now = new Date().toISOString();

      const payload = {
        ...row,
        area_code: areaCodeFromE164(row.e164),
        updated_at: now,
      };
      delete payload.created_at; // avoid upsert confusion

      const { error } = await supabase.from("phone_numbers").upsert(payload, { onConflict: "e164" });
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErr(e.message || "Failed to save");
    } finally {
      setSaving(row.id, false);
    }
  }

  async function unassign(row) {
    await saveRow({ ...row, assigned_user_id: null, assigned_team_id: null });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-medium">Phone Number Pool (10DLC + Toll-Free)</div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadAll}
            disabled={loading}
            className="rounded-md border border-white/20 px-3 py-1 text-sm hover:bg-white/10"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-md border border-white/20 px-3 py-1 text-sm hover:bg-white/10"
          >
            + Add number
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 grid gap-2 md:grid-cols-4">
        <div>
          <div className="mb-1 text-xs text-white/70">Type</div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1 text-xs text-white/70">Status</div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1 text-xs text-white/70">Assignment</div>
          <select
            value={assignFilter}
            onChange={(e) => setAssignFilter(e.target.value)}
            className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
          >
            {ASSIGN.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1 text-xs text-white/70">Search</div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by number, label, campaign…"
            className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left text-white/70">Number</th>
              <th className="px-3 py-2 text-left text-white/70">Type</th>
              <th className="px-3 py-2 text-left text-white/70">Status</th>
              <th className="px-3 py-2 text-left text-white/70">Campaign</th>
              <th className="px-3 py-2 text-left text-white/70">Profile</th>
              <th className="px-3 py-2 text-left text-white/70">Assigned To</th>
              <th className="px-3 py-2 text-left text-white/70">Label</th>
              <th className="px-3 py-2 text-left text-white/70">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const saving = !!savingMap[r.id];
              const user = users.find((u) => u.user_id === r.assigned_user_id);
              return (
                <tr key={r.id} className="border-t border-white/10 align-top">
                  <td className="px-3 py-2">
                    <div className="font-mono">{r.e164}</div>
                    <div className="text-xs text-white/50">AC {r.area_code ?? "—"}</div>
                    <div className="text-[11px] text-white/40">
                      SMS {r.capabilities_sms ? "✓" : "×"} · Voice {r.capabilities_voice ? "✓" : "×"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${
                      r.type === "10dlc" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300"
                    }`}>
                      {r.type}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={r.status || "active"}
                      onChange={(e) => saveRow({ ...r, status: e.target.value })}
                      className="rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                      disabled={saving}
                    >
                      {["active", "suspended", "released"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={r.campaign_id || ""}
                      onChange={(e) => saveRow({ ...r, campaign_id: e.target.value || null })}
                      placeholder={r.type === "10dlc" ? "required" : "—"}
                      className="w-44 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                      disabled={saving || r.type !== "10dlc"}
                    />
                    {r.type === "10dlc" && (
                      <div className={`mt-1 text-[11px] ${r.campaign_id ? "text-emerald-300" : "text-rose-300"}`}>
                        {r.campaign_id ? "Campaign set" : "Missing campaign_id"}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={r.messaging_profile_id || ""}
                      onChange={(e) => saveRow({ ...r, messaging_profile_id: e.target.value || null })}
                      placeholder="profile id"
                      className="w-44 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                      disabled={saving}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <select
                        value={r.assigned_user_id || ""}
                        onChange={(e) => saveRow({ ...r, assigned_user_id: e.target.value || null, assigned_team_id: null })}
                        className="w-56 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                        disabled={saving}
                      >
                        <option value="">— assign to user —</option>
                        {users.map((u) => (
                          <option key={u.user_id} value={u.user_id}>
                            {u.full_name || u.email || u.user_id}
                          </option>
                        ))}
                      </select>

                      <div className="text-center text-xs text-white/40">or</div>

                      <select
                        value={r.assigned_team_id || ""}
                        onChange={(e) => saveRow({ ...r, assigned_team_id: e.target.value || null, assigned_user_id: null })}
                        className="w-56 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                        disabled={saving}
                      >
                        <option value="">— assign to team —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>{t.id}</option>
                        ))}
                      </select>

                      {(r.assigned_user_id || r.assigned_team_id) && (
                        <button
                          onClick={() => unassign(r)}
                          disabled={saving}
                          className="mt-1 w-56 rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
                        >
                          Unassign
                        </button>
                      )}

                      {user && (
                        <div className="text-[11px] text-white/50">
                          ↳ {user.full_name || user.email}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={r.label || ""}
                      onChange={(e) => saveRow({ ...r, label: e.target.value || null })}
                      className="w-44 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                      placeholder="note/label"
                      disabled={saving}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => saveRow(r)}
                      disabled={saving}
                      className="rounded-md border border-white/20 px-3 py-1 hover:bg-white/10"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={8}>
                  No numbers.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="font-medium">Add phone number</div>
              <button onClick={() => setShowAdd(false)} className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10">Close</button>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <label className="block">
                <div className="mb-1 text-xs text-white/70">E.164</div>
                <input
                  value={addForm.e164}
                  onChange={(e) => setAddForm((f) => ({ ...f, e164: e.target.value }))}
                  placeholder="+16155551234"
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                />
              </label>
              <label className="block">
                <div className="mb-1 text-xs text-white/70">Type</div>
                <select
                  value={addForm.type}
                  onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value }))}
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                >
                  <option value="10dlc">10DLC</option>
                  <option value="toll_free">Toll-free</option>
                </select>
              </label>

              <label className="block md:col-span-2">
                <div className="mb-1 text-xs text-white/70">Campaign ID (required for 10DLC)</div>
                <input
                  value={addForm.campaign_id}
                  onChange={(e) => setAddForm((f) => ({ ...f, campaign_id: e.target.value }))}
                  placeholder="example: CMP123abc..."
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                  disabled={addForm.type !== "10dlc"}
                />
              </label>

              <label className="block md:col-span-2">
                <div className="mb-1 text-xs text-white/70">Messaging Profile ID (optional)</div>
                <input
                  value={addForm.messaging_profile_id}
                  onChange={(e) => setAddForm((f) => ({ ...f, messaging_profile_id: e.target.value }))}
                  placeholder="Telnyx messaging profile id"
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                />
              </label>

              <label className="block md:col-span-2">
                <div className="mb-1 text-xs text-white/70">Label (optional)</div>
                <input
                  value={addForm.label}
                  onChange={(e) => setAddForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Note for admins"
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                />
              </label>

              <div className="flex items-center gap-4 md:col-span-2">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addForm.capabilities_sms}
                    onChange={(e) => setAddForm((f) => ({ ...f, capabilities_sms: e.target.checked }))}
                  />
                  <span className="text-sm">SMS</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addForm.capabilities_voice}
                    onChange={(e) => setAddForm((f) => ({ ...f, capabilities_voice: e.target.checked }))}
                  />
                  <span className="text-sm">Voice</span>
                </label>

                <div className="ml-auto">
                  <div className="mb-1 text-xs text-white/70">Status</div>
                  <select
                    value={addForm.status}
                    onChange={(e) => setAddForm((f) => ({ ...f, status: e.target.value }))}
                    className="rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                  >
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="released">released</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                onClick={addNumber}
                className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
              >
                Save number
              </button>
            </div>

            <p className="mt-2 text-xs text-white/45">
              Tip: Assign numbers to users or teams after adding them. 10DLC numbers must reference an approved campaign ID.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
