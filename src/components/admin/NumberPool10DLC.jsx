// File: src/components/admin/NumberPool10DLC.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

/* ---------- tiny UI helpers (same vibe as your TFN section) ---------- */
function Row({ label, children }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 py-1.5 sm:grid-cols-[160px_1fr]">
      <div className="text-xs sm:text-sm text-white/70">{label}</div>
      <div>{children}</div>
    </div>
  );
}
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
function Checkbox({ label, ...rest }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
function toE164(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (!d) return "";
  return d.startsWith("1") ? `+${d}` : `+1${d}`;
}

const PAGE = 50;

/**
 * 10DLC Number Pool (TFN-style minimal UI)
 * Fields we keep: e164 (Number), telnyx_number_id (Number ID), label (optional), verified (bool)
 * Hidden/defaulted: type='10dlc', provider='telnyx'
 */
export default function NumberPool10DLC() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // filters (match TFN simplicity)
  const [q, setQ] = useState("");
  const [onlyVerified, setOnlyVerified] = useState(false);

  // data
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);

  // add form (TFN-esque)
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState({
    e164: "",
    telnyx_number_id: "",
    label: "",
    verified: false,
  });

  const whereBuilder = useMemo(() => {
    return (b) => {
      b = b.eq("type", "10dlc");
      if (onlyVerified) b = b.eq("verified", true);
      if (q.trim()) {
        const term = q.trim();
        b = b.or(`e164.ilike.%${term}%,label.ilike.%${term}%,telnyx_number_id.ilike.%${term}%`);
      }
      return b;
    };
  }, [q, onlyVerified]);

  async function load(reset = false) {
    try {
      setLoading(true);
      setErr("");

      const offset = reset ? 0 : page * PAGE;

      let query = supabase
        .from("phone_numbers")
        .select("id,e164,label,verified,telnyx_number_id,created_at,updated_at,type,provider", { count: "exact" })
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
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, onlyVerified]);

  function patchLocal(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function upsertNumber(payload) {
    const clean = {
      e164: toE164(payload.e164),
      type: "10dlc",
      provider: "telnyx",
      telnyx_number_id: (payload.telnyx_number_id || "").trim() || null,
      label: (payload.label || "").trim() || null,
      verified: !!payload.verified,
      updated_at: new Date().toISOString(),
    };
    if (!clean.e164) throw new Error("Enter a valid phone number.");
    const { data, error } = await supabase
      .from("phone_numbers")
      .upsert(clean, { onConflict: "e164", defaultToNull: false })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function onAddOne() {
    try {
      setSaving(true);
      setErr("");
      await upsertNumber(form);
      setForm({ e164: "", telnyx_number_id: "", label: "", verified: false });
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
        await upsertNumber({ e164: line, telnyx_number_id: "", label: "", verified: false });
      }
      await load(true);
      setBulkOpen(false);
    } catch (e) {
      setErr(e.message || "Bulk import failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveRow(r) {
    try {
      setSaving(true);
      setErr("");
      await upsertNumber(r);
      patchLocal(r.id, { _dirty: false });
    } catch (e) {
      setErr(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function releaseRow(r) {
    // Same behavior your TFN UI had: "Release" removes the row from pool
    try {
      setSaving(true);
      const { error } = await supabase.from("phone_numbers").delete().eq("id", r.id);
      if (error) throw error;
      await load(true);
    } catch (e) {
      setErr(e.message || "Failed to release");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="font-medium">10DLC Number Pool</div>
        <div className="flex flex-wrap gap-2">
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

      {/* Filters (TFN-style simple) */}
      <div className="mb-3 grid gap-2 md:grid-cols-3">
        <TextInput
          placeholder="Search number / label / number ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex items-center gap-4">
          <Checkbox label="Verified only" checked={onlyVerified} onChange={(e) => setOnlyVerified(e.target.checked)} />
        </div>
      </div>

      {/* Add Single (TFN-like) */}
      {addOpen && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-2 text-sm font-medium">Add 10DLC Number</div>
          <div className="grid gap-2 md:grid-cols-2">
            <Row label="Number (E.164)">
              <TextInput
                value={form.e164}
                onChange={(e) => setForm((v) => ({ ...v, e164: e.target.value }))}
                placeholder="+15551234567 or 5551234567"
              />
            </Row>
            <Row label="Number ID">
              <TextInput
                value={form.telnyx_number_id}
                onChange={(e) => setForm((v) => ({ ...v, telnyx_number_id: e.target.value }))}
                placeholder="e.g. 40019936 (or num_… if you use that format)"
              />
            </Row>
            <Row label="Label (optional)">
              <TextInput
                value={form.label}
                onChange={(e) => setForm((v) => ({ ...v, label: e.target.value }))}
                placeholder="Internal note"
              />
            </Row>
            <Row label="Status">
              <Checkbox
                label="Verified"
                checked={!!form.verified}
                onChange={(e) => setForm((v) => ({ ...v, verified: e.target.checked }))}
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

      {/* Bulk Import (just numbers, like TFN) */}
      {bulkOpen && <BulkImporter onCancel={() => setBulkOpen(false)} onImport={onBulkImport} saving={saving} />}

      {/* Table (TFN-style minimal) */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-2 py-2 text-left">Number</th>
              <th className="px-2 py-2 text-left">Number ID</th>
              <th className="px-2 py-2 text-left">Label</th>
              <th className="px-2 py-2 text-left">Verified</th>
              <th className="px-2 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10">
                <td className="px-2 py-2">
                  <EditCell
                    value={r.e164}
                    onChange={(v) => patchLocal(r.id, { e164: v, _dirty: true })}
                    className="font-mono"
                  />
                </td>
                <td className="px-2 py-2">
                  <EditCell
                    value={r.telnyx_number_id || ""}
                    onChange={(v) => patchLocal(r.id, { telnyx_number_id: v, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <EditCell
                    value={r.label || ""}
                    onChange={(v) => patchLocal(r.id, { label: v, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!r.verified}
                    onChange={(e) => patchLocal(r.id, { verified: e.target.checked, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => saveRow(r)}
                      disabled={saving || !r._dirty}
                      className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => releaseRow(r)}
                      disabled={saving}
                      className="rounded-md border border-rose-400/30 px-2 py-1 text-xs hover:bg-rose-500/10"
                    >
                      Release
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={5}>
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

function EditCell({ value, onChange, className }) {
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={[
        "w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 outline-none",
        "focus:ring-2 focus:ring-indigo-500/30",
        className || "",
      ].join(" ")}
    />
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
