import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [prefix, setPrefix] = useState("833"); // 800 excluded
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");

  const prefixes = ["833", "844", "855", "866", "877", "888"]; // no 800

  async function fetchNumbers(p = prefix) {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/tfn-search?prefix=${encodeURIComponent(p)}&limit=30`);
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Search failed");
      setItems(json.items || []);
    } catch (e) {
      setErr(e.message || "Search failed");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchNumbers(prefix); /* eslint-disable-next-line */ }, []);

  async function selectNumber(item) {
    setErr("");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const access = sess?.session?.access_token || "";

      // Always send phone_number; id is optional
      const payload = {
        phone_number: item.phone_number,
        id: item.available_id || item.id || undefined,
      };

      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: access ? `Bearer ${access}` : "",
          "x-supabase-auth": access || "",
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error || "Purchase failed");

      onPicked?.(json.e164 || item.phone_number);
      onClose?.();
    } catch (e) {
      setErr(e.message || "Could not select number");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0b0b12] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Choose a Toll-Free Number</h2>
          <button onClick={onClose} className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">Close</button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <div className="text-xs">Prefix</div>
          <div className="flex gap-1">
            {prefixes.map((p) => (
              <button key={p}
                onClick={() => { setPrefix(p); fetchNumbers(p); }}
                className={[
                  "rounded-md border px-2 py-1 text-xs",
                  p === prefix ? "border-emerald-400/40 bg-emerald-400/10" : "border-white/15 bg-white/5 hover:bg-white/10",
                ].join(" ")}
              >{p}</button>
            ))}
          </div>
          <button onClick={() => fetchNumbers(prefix)} className="ml-auto rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">Refresh</button>
        </div>

        {err && (
          <div className="mb-2 rounded-md border border-rose-400/30 bg-rose-400/10 p-2 text-xs text-rose-200">
            {err}
          </div>
        )}

        <div className="max-h-[360px] overflow-auto rounded-md border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Country</th>
                <th className="px-3 py-2 text-left">Region</th>
                <th className="px-3 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {!loading && items.length === 0 && (
                <tr><td className="px-3 py-3 text-white/60" colSpan={4}>No numbers found for {prefix}. Try another prefix.</td></tr>
              )}
              {loading && <tr><td className="px-3 py-3 text-white/60" colSpan={4}>Loading…</td></tr>}
              {items.map((it) => (
                <tr key={`${it.available_id || it.id || it.phone_number}`}>
                  <td className="px-3 py-2 font-mono">{it.phone_number}</td>
                  <td className="px-3 py-2">{it.country || "US"}</td>
                  <td className="px-3 py-2">{it.region || "-"}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => selectNumber(it)}
                      className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">
                      Select
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 text-[11px] text-white/50">
          Only prefixes 833/844/855/866/877/888 are shown (800 excluded).
        </div>
      </div>
    </div>
  );
}