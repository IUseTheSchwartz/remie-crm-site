// File: src/components/admin/TenDLCPoolAdminSection.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

function TextInput(props) {
  return (
    <input
      {...props}
      className={[
        "w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 outline-none",
        "focus:ring-2 focus:ring-indigo-500/40",
        props.className || "",
      ].join(" ")}
    />
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr] items-center py-1.5">
      <div className="text-xs sm:text-sm text-white/70">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function toE164Raw(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

const PAGE = 50;

export default function TenDLCPoolAdminSection() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Search (like TFN)
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Add + Bulk (like TFN)
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [form, setForm] = useState({
    phone_number: "",
    telnyx_number_id: "",
    verified: false,
    notes: "",
  });

  // Users for assignment (claim)
  const [users, setUsers] = useState([]);
  const userLabel = (uid) => {
    if (!uid) return "—";
    const u = users.find((x) => x.user_id === uid);
    if (!u) return uid;
    return u.full_name ? `${u.full_name} — ${u.email}` : u.email || uid;
  };

  const whereBuilder = useMemo(() => {
    return (b) => {
      if (q.trim()) {
        const term = q.trim();
        b = b.or(
          `phone_number.ilike.%${term}%,telnyx_number_id.ilike.%${term}%,notes.ilike.%${term}%`
        );
      }
      return b;
    };
  }, [q]);

  async function loadUsers() {
    const { data, error } = await supabase
      .from("agent_profiles")
      .select("user_id, full_name, email")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (!error) setUsers(data || []);
  }

  async function load(reset = false) {
    try {
      setLoading(true);
      setErr("");
      const offset = reset ? 0 : page * PAGE;

      let query = supabase
        .from("ten_dlc_numbers")
        .select(
          "id, phone_number, telnyx_number_id, verified, notes, assigned_to, date_assigned, created_at, updated_at",
          { count: "exact" }
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE - 1);

      query = whereBuilder(query);
      const { data, error, count } = await query;
      if (error) throw error;

      if (reset) {
        setRows(data || []);
        setPage(0);
      } else {
        setRows((prev) => [...prev, ...(data || [])]);
      }
      setHasMore(((count ?? 0) - (offset + (data?.length || 0))) > 0);
    } catch (e) {
      setErr(e.message || "Failed to load numbers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function patchRowLocal(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function upsertOne(payload) {
    const clean = {
      ...payload,
      phone_number: toE164Raw(payload.phone_number || payload.e164 || payload.number),
      telnyx_number_id: payload.telnyx_number_id || null,
      verified: !!payload.verified,
      notes: payload.notes || null,
      assigned_to: payload.assigned_to || null,
      date_assigned: payload.assigned_to ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    if (!clean.phone_number) throw new Error("Enter a valid phone number.");
    const { data, error } = await supabase
      .from("ten_dlc_numbers")
      .upsert(clean, { onConflict: "phone_number", defaultToNull: false })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function onAddOne() {
    try {
      setSaving(true);
      setErr("");
      await upsertOne(form);
      setForm({ phone_number: "", telnyx_number_id: "", verified: false, notes: "" });
      await load(true);
      setAddOpen(false);
    } catch (e) {
      setErr(e.message || "Failed to add number");
    } finally {
      setSaving(false);
    }
  }

  async function onBulkImport(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!lines.length) return;
    try {
      setSaving(true);
      setErr("");
      for (const line of lines) {
        await upsertOne({ phone_number: line, verified: false });
      }
      await load(true);
      setBulkOpen(false);
    } catch (e) {
      setErr(e.message || "Bulk import failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveInline(r) {
    try {
      setSaving(true);
      setErr("");
      // Preserve date_assigned if already assigned; set if newly assigned; clear if unassigned
      const next = { ...r };
      if (r.assigned_to && !r.date_assigned) next.date_assigned = new Date().toISOString();
      if (!r.assigned_to) next.date_assigned = null;
      await upsertOne(next);
      patchRowLocal(r.id, { _dirty: false });
    } catch (e) {
      setErr(e.message || "Failed to save row");
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(r) {
    try {
      setSaving(true);
      setErr("");
      const { error } = await supabase.from("ten_dlc_numbers").delete().eq("id", r.id);
      if (error) throw error;
      await load(true);
    } catch (e) {
      setErr(e.message || "Failed to release");
    } finally {
      setSaving(false);
    }
  }

  async function unassignRow(r) {
    try {
      setSaving(true);
      setErr("");
      const { error } = await supabase
        .from("ten_dlc_numbers")
        .update({ assigned_to: null, date_assigned: null, updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) throw error;
      await load(true);
    } catch (e) {
      setErr(e.message || "Failed to unassign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="font-medium">10DLC Number Pool</div>
        <div className="flex flex-wrap gap-2">
          <TextInput
            placeholder="Search number / telnyx id / notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-60"
          />
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            onClick={() => setAddOpen((v) => !v)}
            className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
          >
            + Add number
          </button>
          <button
            onClick={() => setBulkOpen((v) => !v)}
            className="rounded-md border border-indigo-400/30 px-3 py-1.5 text-sm hover:bg-indigo-400/10"
          >
            Bulk import
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Add Single (TFN-style) */}
      {addOpen && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-2 text-sm font-medium">Add 10DLC Number</div>
          <div className="grid gap-2 md:grid-cols-2">
            <Row label="Number (E.164)">
              <TextInput
                value={form.phone_number}
                onChange={(e) => setForm((v) => ({ ...v, phone_number: e.target.value }))}
                placeholder="+15551234567"
              />
            </Row>
            <Row label="Telnyx Number ID">
              <TextInput
                value={form.telnyx_number_id}
                onChange={(e) => setForm((v) => ({ ...v, telnyx_number_id: e.target.value }))}
                placeholder="40019936 / num_XXXX"
              />
            </Row>
            <Row label="Verified">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!form.verified}
                  onChange={(e) => setForm((v) => ({ ...v, verified: e.target.checked }))}
                />
                <span>Mark as verified</span>
              </label>
            </Row>
            <Row label="Notes (optional)">
              <TextInput
                value={form.notes}
                onChange={(e) => setForm((v) => ({ ...v, notes: e.target.value }))}
                placeholder="Any comment…"
              />
            </Row>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              onClick={() => setAddOpen(false)}
              className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              onClick={onAddOne}
              disabled={saving}
              className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
            >
              {saving ? "Saving…" : "Add"}
            </button>
          </div>
        </div>
      )}

      {/* Bulk Import */}
      {bulkOpen && (
        <BulkImporter
          onCancel={() => setBulkOpen(false)}
          onImport={onBulkImport}
          saving={saving}
        />
      )}

      {/* Table (TFN-style + assignment) */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-2 py-2 text-left">Number</th>
              <th className="px-2 py-2 text-left">Telnyx ID</th>
              <th className="px-2 py-2 text-left">Verified</th>
              <th className="px-2 py-2 text-left">Notes</th>
              <th className="px-2 py-2 text-left">Assigned To</th>
              <th className="px-2 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isLocked = !!r.assigned_to; // lock editing when assigned (like old TFN)
              return (
                <tr key={r.id} className="border-t border-white/10 align-top">
                  <td className="px-2 py-2">
                    <TextInput
                      value={r.phone_number}
                      onChange={(e) =>
                        patchRowLocal(r.id, { phone_number: e.target.value, _dirty: true })
                      }
                      className={`font-mono ${isLocked ? "opacity-60 pointer-events-none" : ""}`}
                      disabled={isLocked}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <TextInput
                      value={r.telnyx_number_id || ""}
                      onChange={(e) =>
                        patchRowLocal(r.id, { telnyx_number_id: e.target.value, _dirty: true })
                      }
                      className={isLocked ? "opacity-60 pointer-events-none" : ""}
                      disabled={isLocked}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={!!r.verified}
                      onChange={(e) =>
                        patchRowLocal(r.id, { verified: e.target.checked, _dirty: true })
                      }
                      disabled={isLocked}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <TextInput
                      value={r.notes || ""}
                      onChange={(e) => patchRowLocal(r.id, { notes: e.target.value, _dirty: true })}
                      className={isLocked ? "opacity-60 pointer-events-none" : ""}
                      disabled={isLocked}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="space-y-1">
                      <select
                        value={r.assigned_to || ""}
                        onChange={(e) =>
                          patchRowLocal(r.id, {
                            assigned_to: e.target.value || null,
                            _dirty: true,
                          })
                        }
                        className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/40"
                      >
                        <option value="">— Unassigned —</option>
                        {users.map((u) => (
                          <option key={u.user_id} value={u.user_id}>
                            {u.full_name ? `${u.full_name} — ${u.email}` : u.email || u.user_id}
                          </option>
                        ))}
                      </select>
                      <div className="text-[11px] text-white/50">
                        {r.assigned_to ? `Assigned: ${userLabel(r.assigned_to)}` : "Available"}
                      </div>
                      <div className="text-[11px] text-white/40">
                        {r.date_assigned ? `Since: ${new Date(r.date_assigned).toLocaleString()}` : ""}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => saveInline(r)}
                        disabled={saving || !r._dirty}
                        className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
                      >
                        {r.assigned_to && r._dirty ? "Update" : r._dirty ? "Save" : "Save"}
                      </button>
                      {r.assigned_to ? (
                        <button
                          onClick={() => unassignRow(r)}
                          disabled={saving}
                          className="rounded-md border border-amber-400/30 px-2 py-1 text-xs hover:bg-amber-500/10"
                        >
                          Unassign
                        </button>
                      ) : (
                        <button
                          onClick={() => removeRow(r)}
                          disabled={saving}
                          className="rounded-md border border-rose-400/30 px-2 py-1 text-xs hover:bg-rose-500/10"
                        >
                          Release
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={6}>
                  No numbers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => {
              setPage((p) => p + 1);
              load(false);
            }}
            disabled={loading}
            className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function BulkImporter({ onCancel, onImport, saving }) {
  const [text, setText] = useState("");
  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 text-sm font-medium">Bulk import numbers (one per line)</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-40 w-full rounded-md border border-white/15 bg-black/40 p-2 outline-none focus:ring-2 focus:ring-indigo-500/40"
        placeholder="+15551234567\n+16155551234\n…"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          onClick={() => onImport(text)}
          disabled={saving}
          className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
        >
          {saving ? "Importing…" : "Import"}
        </button>
      </div>
    </div>
  );
}
