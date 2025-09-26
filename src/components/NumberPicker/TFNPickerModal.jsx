// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const PREFIXES = ["800", "833", "844", "855", "866", "877", "888"];

export default function TFNPickerModal({ userId, onPicked, onClose }) {
  const [prefix, setPrefix] = useState("800");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selectingId, setSelectingId] = useState(null);

  async function search() {
    setErr("");
    setItems([]);
    setLoading(true);
    try {
      const res = await fetch(
        `/.netlify/functions/tfn-search?prefix=${encodeURIComponent(prefix)}&limit=30`
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Search failed");
      }
      setItems(data.items || []);
      if (!data.items?.length) setErr(`No numbers found for ${prefix}. Try a different prefix.`);
    } catch (e) {
      setErr(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // auto search once when opened
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(item) {
    setErr("");
    setSelectingId(item.id);
    try {
      // auth: include Supabase access token for the Netlify function
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token || "";
      if (!token) throw new Error("You need to sign in again.");

      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          telnyx_phone_id: item.id,
          e164: item.phone_number,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || "Could not purchase/assign number");
      }

      // success — return the chosen number to the page
      onPicked?.(item.phone_number);
      onClose?.();
    } catch (e) {
      setErr(e.message || "Selection failed");
    } finally {
      setSelectingId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    >
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#101018] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Choose a Toll-Free Number</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
          >
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
            {PREFIXES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={search}
            disabled={loading}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10 disabled:opacity-50"
          >
            {loading ? "Searching..." : "Refresh"}
          </button>
        </div>

        {err && (
          <div className="mb-3 rounded-md border border-rose-400/20 bg-rose-400/10 p-2 text-xs text-rose-200">
            {err}
          </div>
        )}

        <div className="max-h-[60vh] overflow-auto rounded-md border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-left text-xs text-white/60">
              <tr>
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Country</th>
                <th className="px-3 py-2">Region</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && !loading && (
                <tr>
                  <td className="px-3 py-3 text-white/60" colSpan={4}>
                    No numbers found for {prefix}. Try a different prefix.
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.id} className="border-t border-white/10">
                  <td className="px-3 py-2 font-mono">{it.phone_number}</td>
                  <td className="px-3 py-2">{it.country || "-"}</td>
                  <td className="px-3 py-2">{it.region || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => select(it)}
                      disabled={!!selectingId}
                      className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
                    >
                      {selectingId === it.id ? "Selecting…" : "Select"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-[11px] text-white/50">
          Selecting a number will purchase it via Telnyx, assign your messaging profile, and link it to your account.
        </p>
      </div>
    </div>
  );
}