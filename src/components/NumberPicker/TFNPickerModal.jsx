// src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useState } from "react";
import { searchTFNs, selectTFN } from "../../lib/tfnClient";

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [loading, setLoading] = useState(true);
  const [prefix, setPrefix] = useState("888");
  const [page, setPage] = useState(1);
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    setLoading(true);
    setMsg("");
    try {
      const r = await searchTFNs({ prefix, page, size: 25 });
      setList(r?.numbers || []);
    } catch (e) {
      setMsg(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [prefix, page]);

  async function pick(n) {
    if (!userId) return alert("Not signed in");
    setBusy(true);
    setMsg("");
    try {
      const out = await selectTFN({ userId, phone_number: n });
      setMsg(`Assigned ${out.number}`);
      onPicked?.(out.number);
      onClose?.();
    } catch (e) {
      setMsg(e.message || "Failed to assign number");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Choose a Toll-Free Number</h3>
          <button className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10" onClick={onClose}>Close</button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-white/70">Prefix</label>
          <select
            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm"
            value={prefix}
            onChange={(e) => { setPage(1); setPrefix(e.target.value); }}
          >
            {["833","844","855","866","877","888"].map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <div className="ml-auto flex items-center gap-2">
            <button className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>Prev</button>
            <div className="text-xs text-white/60">Page {page}</div>
            <button className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs" onClick={()=>setPage(p=>p+1)}>Next</button>
          </div>
        </div>

        {loading ? (
          <div className="py-6 text-center text-white/70">Loading numbers…</div>
        ) : list.length === 0 ? (
          <div className="py-6 text-center text-white/70">No numbers available. Try another prefix or page.</div>
        ) : (
          <div className="grid max-h-[50vh] grid-cols-1 gap-2 overflow-auto">
            {list.map((n) => (
              <div key={n.phone_number} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] p-2">
                <div className="text-sm">{n.phone_number}</div>
                <button
                  disabled={busy}
                  onClick={() => pick(n.phone_number)}
                  className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50"
                >
                  Select
                </button>
              </div>
            ))}
          </div>
        )}

        {msg && <div className="mt-3 text-xs text-amber-300">{msg}</div>}
      </div>
    </div>
  );
}
