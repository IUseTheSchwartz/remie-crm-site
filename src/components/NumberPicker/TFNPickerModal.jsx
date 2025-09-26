// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function TFNPickerModal({ onClose, onPicked, userId }) {
  const [prefix, setPrefix] = useState("800");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [err, setErr] = useState("");

  async function searchNumbers() {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/.netlify/functions/tfn-search?prefix=" + encodeURIComponent(prefix));
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Search failed");
      setResults(data.numbers || []);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function selectNumber(item) {
    setErr("");
    setLoading(true);
    try {
      // 🔐 fetch Supabase access token
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error("You must be signed in.");

      const mp = import.meta.env.VITE_TELNYX_MESSAGING_PROFILE_ID || "";

      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`, // 👈 important
        },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-w-lg w-full rounded-xl border border-white/10 bg-[#0b0b12] p-6 shadow-xl">
        <h2 className="text-lg font-semibold mb-4">Choose Toll-Free Number</h2>

        <div className="flex items-center gap-2 mb-4">
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            className="flex-1 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
            placeholder="e.g. 800"
          />
          <button
            onClick={searchNumbers}
            disabled={loading}
            className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
          >
            Search
          </button>
        </div>

        {err && <div className="mb-3 text-sm text-rose-400">{err}</div>}

        <div className="max-h-80 overflow-y-auto space-y-2">
          {results.map((r) => (
            <div
              key={r.phone_number}
              className="flex items-center justify-between rounded-md border border-white/10 bg-white/5 p-2 text-sm"
            >
              <div>
                <div className="font-mono">{r.phone_number}</div>
                <div className="text-xs text-white/50">{r.region || "Toll-Free"}</div>
              </div>
              <button
                onClick={() => selectNumber(r)}
                disabled={loading}
                className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
              >
                Select
              </button>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md border border-white/20 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}