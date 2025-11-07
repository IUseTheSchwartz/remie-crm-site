// File: src/components/admin/NumberPool10DLC.jsx
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

/* --- helpers (match old TFN vibe) --- */
function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}
function toE164(usLike) {
  const d = onlyDigits(usLike);
  if (!d) return "";
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.startsWith("+") ? `+${onlyDigits(usLike)}` : `+${d}`;
}
function parseAreaCode(e164) {
  const d = onlyDigits(e164);
  if (d.length === 11 && d.startsWith("1")) return Number(d.slice(1, 4)) || null;
  if (d.length === 10) return Number(d.slice(0, 3)) || null;
  return null;
}

export default function NumberPool10DLC() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // minimal add form
  const [numInput, setNumInput] = useState("");
  const [idInput, setIdInput] = useState("");

  // rows
  const [rows, setRows] = useState([]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const { data, error } = await supabase
        .from("phone_numbers")
        .select("id, e164, telnyx_number_id, created_at")
        .eq("type", "10dlc")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setErr(e.message || "Failed to load numbers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addNumber(e) {
    e?.preventDefault?.();
    setErr("");

    const e164 = toE164(numInput);
    const telnyxId = String(idInput || "").trim();

    if (!e164 || e164.length < 12) {
      setErr("Enter a valid US number in E.164 (e.g., +16155551234).");
      return;
    }
    if (!/^\d+$/.test(telnyxId)) {
      setErr("Telnyx Number ID must be numeric (e.g., 40019936).");
      return;
    }

    const ac = parseAreaCode(e164);

    try {
      const payload = {
        e164,
        type: "10dlc",
        provider: "telnyx",
        telnyx_number_id: telnyxId,
        // keep everything else implicit/minimal
        messaging_profile_id: null, // using env in your send function
        campaign_id: null,          // optional; you’re handling this in Telnyx
        area_code: ac,
        capabilities_sms: true,
        capabilities_voice: false,  // SMS-only as requested
        status: "active",
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("phone_numbers")
        .upsert(payload, { onConflict: "e164" });
      if (error) throw error;

      setNumInput("");
      setIdInput("");
      await load();
    } catch (e) {
      setErr(e.message || "Failed to add number");
    }
  }

  async function removeNumber(rowId) {
    setErr("");
    try {
      const { error } = await supabase.from("phone_numbers").delete().eq("id", rowId);
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(e.message || "Failed to remove number");
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-medium">10DLC Number Pool</div>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Minimal add form: Number + Telnyx Number ID */}
      <form
        onSubmit={addNumber}
        className="mb-4 grid items-end gap-2 sm:grid-cols-[1fr_220px_auto]"
      >
        <label className="block">
          <div className="mb-1 text-xs text-white/70">Number (E.164)</div>
          <input
            value={numInput}
            onChange={(e) => setNumInput(e.target.value)}
            placeholder="+16155551234"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500/40"
          />
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-white/70">Telnyx Number ID</div>
          <input
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            placeholder="40019936"
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500/40"
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md border border-emerald-400/30 px-3 py-2 text-sm hover:bg-emerald-400/10"
        >
          {saving ? "Saving…" : "+ Add"}
        </button>
      </form>

      {/* Minimal table: Number, Telnyx ID, Added, Actions */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left text-white/70">Number</th>
              <th className="px-3 py-2 text-left text-white/70">Telnyx ID</th>
              <th className="px-3 py-2 text-left text-white/70">Added</th>
              <th className="px-3 py-2 text-left text-white/70">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10">
                <td className="px-3 py-2">{r.e164}</td>
                <td className="px-3 py-2">{r.telnyx_number_id || "—"}</td>
                <td className="px-3 py-2">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => removeNumber(r.id)}
                    className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={4}>
                  No 10DLC numbers yet. Add one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-white/45">
        Uses <code>type='10dlc'</code>, <code>provider='telnyx'</code>, <code>status='active'</code>, <code>capabilities_sms=true</code>, <code>capabilities_voice=false</code>.
        MP/Campaign stay configured in Telnyx; we only store the number and its Telnyx ID here.
      </p>
    </div>
  );
}
