// File: src/components/admin/NumberPool10DLC.jsx
import { useEffect, useState, useMemo } from "react";
import { supabase } from "../../lib/supabaseClient.js";

/* ---------- small UI bits ---------- */
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
  const d = String(s || "").replace(/\D/g, "");
  if (!d) return "";
  return d.startsWith("1") ? `+${d}` : `+1${d}`;
}

/* ---------- component ---------- */
const PAGE = 50;

export default function NumberPool10DLC() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // filters (keep it super simple like your TFN UI)
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);

  // add form: only Number + Telnyx Number ID + Verified
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({
    e164: "",
    telnyx_number_id: "",
    verified: true,
  });

  const whereBuilder = useMemo(() => {
    return (b) => {
      b = b.eq("type", "10dlc");
      // default: show only active numbers for quick pool management
      b = b.eq("status", "active");
      if (q.trim()) {
        const term = q.trim();
        b = b.or(`e164.ilike.%${term}%,telnyx_number_id.ilike.%${term}%`);
      }
      return b;
    };
  }, [q]);

  async function load(reset = false) {
    try {
      setLoading(true);
      setErr("");

      const offset = reset ? 0 : page * PAGE;

      let query = supabase
        .from("phone_numbers")
        .select("id,e164,telnyx_number_id,verified,status,created_at,updated_at", { count: "exact" })
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
  }, [q]);

  function patchRowLocal(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function upsertNumber({ id, e164, telnyx_number_id, verified }) {
    const clean = {
      id,
      e164: toE164Raw(e164),
      telnyx_number_id: telnyx_number_id || null,
      verified: !!verified,
      type: "10dlc",
      // lock these to sensible defaults for pool mgmt
      provider: "telnyx",
      capabilities_sms: true,
      capabilities_voice: false,
      status: "active",
      updated_at: new Date().toISOString(),
    };
    if (!clean.e164) throw new Error("Enter a valid phone number.");
    const { error } = await supabase
      .from("phone_numbers")
      .upsert(clean, { onConflict: "e164", defaultToNull: false });
    if (error) throw error;
  }

  async function onAddOne() {
    try {
      setSaving(true);
      setErr("");
      await upsertNumber(form);
      setForm({ e164: "", telnyx_number_id: "", verified: true });
      await load(true);
      setAddOpen(false);
    } catch (e) {
      setErr(e.message || "Failed to add number");
    } finally {
      setSaving(false);
    }
  }

  async function saveInline(r) {
    try {
      setSaving(true);
      setErr("");
      await upsertNumber({
        id: r.id,
        e164: r.e164,
        telnyx_number_id: r.telnyx_number_id,
        verified: r.verified,
      });
      patchRowLocal(r.id, { _dirty: false });
    } catch (e) {
      setErr(e.message || "Failed to save row");
    } finally {
      setSaving(false);
    }
  }

  async function releaseRow(r) {
    try {
      setSaving(true);
      setErr("");
      const { error } = await supabase
        .from("phone_numbers")
        .update({
          status: "released",
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.id);
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
          <TextInput
            placeholder="Search number or Telnyx ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-56"
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
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Add Single (TFN-style minimal) */}
      {addOpen && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-2 text-sm font-medium">Add 10DLC Number</div>
          <div className="grid gap-2 md:grid-cols-2">
            <Row label="E.164 (e.g. +15551234567)">
              <TextInput
                value={form.e164}
                onChange={(e) => setForm((v) => ({ ...v, e164: e.target.value }))}
                placeholder="+1… or 555…"
              />
            </Row>
            <Row label="Telnyx Number ID">
              <TextInput
                value={form.telnyx_number_id}
                onChange={(e) => setForm((v) => ({ ...v, telnyx_number_id: e.target.value }))}
                placeholder="(e.g. 40019936 or num_xxx)"
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

      {/* Table (TFN-style minimal) */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-2 py-2 text-left">Number</th>
              <th className="px-2 py-2 text-left">Telnyx ID</th>
              <th className="px-2 py-2 text-left">Verified</th>
              <th className="px-2 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10 align-top">
                <td className="px-2 py-2">
                  <TextInput
                    value={r.e164}
                    onChange={(e) => patchRowLocal(r.id, { e164: e.target.value, _dirty: true })}
                    className="font-mono"
                  />
                  <div className="mt-1 text-[11px] text-white/50">Status: {r.status}</div>
                </td>
                <td className="px-2 py-2">
                  <TextInput
                    value={r.telnyx_number_id || ""}
                    onChange={(e) =>
                      patchRowLocal(r.id, { telnyx_number_id: e.target.value, _dirty: true })
                    }
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!r.verified}
                    onChange={(e) => patchRowLocal(r.id, { verified: e.target.checked, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => saveInline(r)}
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
                <td className="px-3 py-6 text-center text-white/60" colSpan={4}>
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
