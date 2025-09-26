// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useState } from "react";

const PREFIXES = ["800", "833", "844", "855", "866", "877", "888"];

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [prefix, setPrefix] = useState("888");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/tfn-search?prefix=${encodeURIComponent(prefix)}&limit=30&page=1`);
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Search failed");
      setRows(data.items || []);
    } catch (e) {
      setErr(e.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix]);

  async function selectNumber(item) {
    setErr("");
    setLoading(true);
    try {
      const mp = import.meta.env.VITE_TELNYX_MESSAGING_PROFILE_ID || ""; // optional front-end env
      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: item.phone_number,
          phone_id: item.id,
          messaging_profile_id: mp || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Select failed");
      onPicked?.(data.number?.e164 || item.phone_number);
      onClose?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Choose a Toll-Free Number</h3>
          <button onClick={onClose} className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">Close</button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-white/70">Prefix</label>
          <select
            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm outline-none"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          >
            {PREFIXES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={load} className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">Refresh</button>
          {loading && <span className="text-xs text-white/60">Loading…</span>}
          {err && <span className="text-xs text-rose-300">Error: {err}</span>}
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                <th className="text-left px-3 py-2">Number</th>
                <th className="text-left px-3 py-2">Country</th>
                <th className="text-left px-3 py-2">Region</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-white/60">No numbers found for {prefix}.</td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/10">
                  <td className="px-3 py-2 font-medium">{r.phone_number}</td>
                  <td className="px-3 py-2">{r.country}</td>
                  <td className="px-3 py-2">{r.region || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => selectNumber(r)}
                      disabled={loading}
                      className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
                    >
                      Select
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[11px] text-white/50">
          Selecting a number will purchase it via Telnyx, assign the messaging profile, and link it to your account.
        </p>
      </div>
    </div>
  );
}