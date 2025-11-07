// File: src/components/admin/NumberPool10DLC.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr] items-center py-1.5">
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

function Select(props) {
  return (
    <select
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

function toE164Raw(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

const PAGE = 50;

export default function NumberPool10DLC() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active"); // active | suspended | released | all
  const [onlySMS, setOnlySMS] = useState(false);
  const [onlyVoice, setOnlyVoice] = useState(false);

  // data
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);

  // add form
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [form, setForm] = useState({
    e164: "",
    area_code: "",
    label: "",
    capabilities_sms: true,
    capabilities_voice: true,
    messaging_profile_id: "",
    campaign_id: "",
    telnyx_number_id: "",
    status: "active",
  });

  const whereBuilder = useMemo(() => {
    return (b) => {
      b = b.eq("type", "10dlc");
      if (status !== "all") b = b.eq("status", status);
      if (onlySMS) b = b.eq("capabilities_sms", true);
      if (onlyVoice) b = b.eq("capabilities_voice", true);
      if (q.trim()) {
        const term = q.trim();
        b = b.or(`e164.ilike.%${term}%,label.ilike.%${term}%`);
      }
      return b;
    };
  }, [q, status, onlySMS, onlyVoice]);

  async function load(reset = false) {
    try {
      setLoading(true);
      setErr("");

      const offset = reset ? 0 : page * PAGE;

      let query = supabase
        .from("phone_numbers")
        .select(
          "id,e164,type,provider,telnyx_number_id,messaging_profile_id,campaign_id,area_code,capabilities_sms,capabilities_voice,status,label,created_at,updated_at",
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
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, onlySMS, onlyVoice]);

  function patchRowLocal(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function upsertNumber(payload) {
    const clean = {
      ...payload,
      e164: toE164Raw(payload.e164),
      type: "10dlc",
      provider: "telnyx",
      area_code:
        payload.area_code && String(payload.area_code).trim() !== ""
          ? Number(String(payload.area_code).replace(/\D/g, "") || null)
          : null,
      label: payload.label || null,
      messaging_profile_id: payload.messaging_profile_id || null,
      campaign_id: payload.campaign_id || null,
      telnyx_number_id: payload.telnyx_number_id || null,
      capabilities_sms: !!payload.capabilities_sms,
      capabilities_voice: !!payload.capabilities_voice,
      status: payload.status || "active",
      updated_at: new Date().toISOString(),
    };
    if (!clean.e164) throw new Error("Enter a valid phone number.");
    const { error, data } = await supabase
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
      setForm({
        e164: "",
        area_code: "",
        label: "",
        capabilities_sms: true,
        capabilities_voice: true,
        messaging_profile_id: "",
        campaign_id: "",
        telnyx_number_id: "",
        status: "active",
      });
      await load(true);
      setAddOpen(false);
    } catch (e) {
      setErr(e.message || "Failed to add number");
    } finally {
      setSaving(false);
    }
  }

  async function onBulkImport(lines) {
    const list = String(lines || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!list.length) return;

    try {
      setSaving(true);
      setErr("");
      for (const line of list) {
        await upsertNumber({
          e164: line,
          area_code: "",
          label: "",
          capabilities_sms: true,
          capabilities_voice: true,
          messaging_profile_id: "",
          campaign_id: "",
          telnyx_number_id: "",
          status: "active",
        });
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
      const payload = { ...r, type: "10dlc" };
      await upsertNumber(payload);
      patchRowLocal(r.id, { _dirty: false });
    } catch (e) {
      setErr(e.message || "Failed to save row");
    } finally {
      setSaving(false);
    }
  }

  async function releaseRow(r) {
    // mark released (and clear any future assignment columns if they exist server-side)
    try {
      setSaving(true);
      const { error } = await supabase
        .from("phone_numbers")
        .update({
          status: "released",
          updated_at: new Date().toISOString(),
          // assigned_user_id: null,
          // assigned_team_id: null,
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

  function EditCell({ value, onChange, type = "text", className }) {
    return (
      <input
        type={type}
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

      {/* Filters (simplified like TFN) */}
      <div className="mb-3 grid gap-2 md:grid-cols-4">
        <TextInput placeholder="Search number/label…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Status: active</option>
          <option value="suspended">Status: suspended</option>
          <option value="released">Status: released</option>
          <option value="all">Status: all</option>
        </Select>
        <div className="flex items-center gap-4">
          <Checkbox label="SMS" checked={onlySMS} onChange={(e) => setOnlySMS(e.target.checked)} />
          <Checkbox label="Voice" checked={onlyVoice} onChange={(e) => setOnlyVoice(e.target.checked)} />
        </div>
      </div>

      {/* Add Single */}
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
            <Row label="Area code (optional)">
              <TextInput
                value={form.area_code}
                onChange={(e) => setForm((v) => ({ ...v, area_code: e.target.value }))}
                placeholder="615"
              />
            </Row>
            <Row label="Label">
              <TextInput
                value={form.label}
                onChange={(e) => setForm((v) => ({ ...v, label: e.target.value }))}
                placeholder="Nashville Main"
              />
            </Row>
            <Row label="Messaging Profile ID">
              <TextInput
                value={form.messaging_profile_id}
                onChange={(e) => setForm((v) => ({ ...v, messaging_profile_id: e.target.value }))}
                placeholder="mp-XXXX"
              />
            </Row>
            <Row label="A2P Campaign ID">
              <TextInput
                value={form.campaign_id}
                onChange={(e) => setForm((v) => ({ ...v, campaign_id: e.target.value }))}
                placeholder="CXXXX"
              />
            </Row>
            <Row label="Telnyx Number ID">
              <TextInput
                value={form.telnyx_number_id}
                onChange={(e) => setForm((v) => ({ ...v, telnyx_number_id: e.target.value }))}
                placeholder="num_XXXX"
              />
            </Row>
            <Row label="Capabilities">
              <div className="flex items-center gap-4">
                <Checkbox
                  label="SMS"
                  checked={!!form.capabilities_sms}
                  onChange={(e) => setForm((v) => ({ ...v, capabilities_sms: e.target.checked }))}
                />
                <Checkbox
                  label="Voice"
                  checked={!!form.capabilities_voice}
                  onChange={(e) => setForm((v) => ({ ...v, capabilities_voice: e.target.checked }))}
                />
              </div>
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
      {bulkOpen && <BulkImporter onCancel={() => setBulkOpen(false)} onImport={onBulkImport} saving={saving} />}

      {/* Table (simplified like TFN) */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-2 py-2 text-left">Number</th>
              <th className="px-2 py-2 text-left">Label</th>
              <th className="px-2 py-2 text-left">Status</th>
              <th className="px-2 py-2 text-left">SMS</th>
              <th className="px-2 py-2 text-left">Voice</th>
              <th className="px-2 py-2 text-left">MP ID</th>
              <th className="px-2 py-2 text-left">Campaign</th>
              <th className="px-2 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10 align-top">
                <td className="px-2 py-2">
                  <EditCell
                    value={r.e164}
                    onChange={(v) => patchRowLocal(r.id, { e164: v, _dirty: true })}
                    className="font-mono"
                  />
                  <div className="mt-1 text-[11px] text-white/50">
                    AC: {r.area_code ?? "—"} • {r.provider}
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/40">TNX: {r.telnyx_number_id || "—"}</div>
                </td>
                <td className="px-2 py-2">
                  <EditCell value={r.label} onChange={(v) => patchRowLocal(r.id, { label: v, _dirty: true })} />
                </td>
                <td className="px-2 py-2">
                  <Select
                    value={r.status}
                    onChange={(e) => patchRowLocal(r.id, { status: e.target.value, _dirty: true })}
                  >
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="released">released</option>
                  </Select>
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!r.capabilities_sms}
                    onChange={(e) => patchRowLocal(r.id, { capabilities_sms: e.target.checked, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!r.capabilities_voice}
                    onChange={(e) => patchRowLocal(r.id, { capabilities_voice: e.target.checked, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <EditCell
                    value={r.messaging_profile_id || ""}
                    onChange={(v) => patchRowLocal(r.id, { messaging_profile_id: v, _dirty: true })}
                  />
                </td>
                <td className="px-2 py-2">
                  <EditCell
                    value={r.campaign_id || ""}
                    onChange={(v) => patchRowLocal(r.id, { campaign_id: v, _dirty: true })}
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
                <td className="px-3 py-6 text-center text-white/60" colSpan={8}>
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
