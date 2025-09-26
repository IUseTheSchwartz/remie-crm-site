// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Loader2 } from "lucide-react";

/**
 * Props:
 *  - userId: string (required)
 *  - onClose: () => void
 *  - onPicked: (e164: string) => void
 */
export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [prefix, setPrefix] = useState("888");
  const [rows, setRows] = useState([]);

  const prefixes = useMemo(() => ["800", "833", "844", "855", "866", "877", "888"], []);

  async function authHeaders() {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function search() {
    setError("");
    setLoading(true);
    setRows([]);
    try {
      // Your TFN-only Netlify function
      const res = await fetch("/.netlify/functions/tfn-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prefix }), // e.g. "800", "888", etc.
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `search failed (${res.status})`);
      }
      const data = await res.json().catch(() => ({}));

      // Normalize typical shapes: { numbers: [...] } or just [...]
      const list = Array.isArray(data) ? data : Array.isArray(data?.numbers) ? data.numbers : [];
      const normalized = list
        .map((n) => ({
          phone_number: n.phone_number || n.e164 || n.number || "",
          country: n.country || n.country_iso || "US",
          region: n.region || "-",
        }))
        .filter((n) => n.phone_number?.startsWith("+1"));

      setRows(normalized);
    } catch (e) {
      setError(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function selectNumber(e164) {
    setWorking(true);
    setError("");
    try {
      // Purchases + assigns via your TFN-select function
      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ phone_number: e164 }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `order failed (${res.status})`);
      }
      onPicked?.(e164);
      onClose?.();
    } catch (e) {
      setError(e.message || "Purchase failed");
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Choose a Toll-Free Number">
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Choose a Toll-Free Number</h2>
          <button type="button" onClick={onClose} className="rounded-md border border-white/15 bg-white/5 px-3 py-1 text-xs hover:bg-white/10">
            Close
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-white/70">Prefix</label>
          <select
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm outline-none"
          >
            {prefixes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={search}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? "Searching…" : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-400/10 p-2 text-xs text-rose-200">{error}</div>
        )}

        <div className="max-h-[420px] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-xs text-white/70">
              <tr>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Country</th>
                <th className="px-3 py-2 text-left">Region</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-white/60">
                    No numbers found for {prefix}. Try a different prefix.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.phone_number} className="border-t border-white/10">
                    <td className="px-3 py-2 font-mono">{r.phone_number}</td>
                    <td className="px-3 py-2">{r.country || "US"}</td>
                    <td className="px-3 py-2">{r.region || "-"}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => selectNumber(r.phone_number)}
                        className="rounded-md border border-white/15 bg-white/5 px-3 py-1 text-xs hover:bg-white/10 disabled:opacity-60"
                      >
                        {working ? "Working…" : "Select"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-2 text-[11px] text-white/50">
          Selecting a number will purchase it via Telnyx, assign the messaging profile, and link it to your account.
        </div>
      </div>
    </div>
  );
}