// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useMemo, useState } from "react";
import { X, Search, Check, Loader2, Phone } from "lucide-react";

const PREFIXES = ["All", "800", "833", "844", "855", "866", "877", "888"];

export default function TFNPickerModal({ userId, onPicked, onClose }) {
  const [loading, setLoading] = useState(true);
  const [numbers, setNumbers] = useState([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [prefix, setPrefix] = useState("All");
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const r = await fetch("/.netlify/functions/telnyx-list-my-numbers");
        if (!r.ok) {
          const t = await r.text();
          throw new Error(t || `HTTP ${r.status}`);
        }
        const j = await r.json();
        if (!mounted) return;
        setNumbers(Array.isArray(j.numbers) ? j.numbers : []);
      } catch (e) {
        if (!mounted) return;
        setError(e.message || "Failed to load numbers");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim();
    return numbers.filter((n) => {
      const e = (n.e164 || "").replace(/\D/g, ""); // digits only for matching
      // prefix filter
      if (prefix !== "All") {
        // Toll-free start is +1 8xx..., so we check after country code
        // Accept both with or without plus
        const starts = e.startsWith("1" + prefix); // e.g., 1888...
        if (!starts) return false;
      }
      // query filter
      if (!term) return true;
      return (n.e164 || "").toLowerCase().includes(term.toLowerCase());
    });
  }, [numbers, q, prefix]);

  async function selectNumber(n) {
    try {
      setPendingId(n.id);
      setError("");
      const res = await fetch("/.netlify/functions/assign-tfn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          telnyx_phone_id: n.id,
          e164: n.e164,
          telnyx_messaging_profile_id: n.messaging_profile_id || null,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error("Failed to assign number");
      // notify parent so UI updates immediately
      onPicked?.(n.e164);
      onClose?.();
    } catch (e) {
      setError(e.message || "Failed to assign number");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Choose Toll-Free Number"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0b0b12] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            <h2 className="text-sm font-semibold">Choose Toll-Free Number</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-white/15 bg-white/5 p-1 hover:bg-white/10"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="p-3 border-b border-white/10">
          <div className="flex flex-wrap items-center gap-2">
            {PREFIXES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPrefix(p)}
                className={[
                  "rounded-full px-3 py-1 text-xs border",
                  prefix === p
                    ? "bg-emerald-500/15 text-emerald-300 border-white/15"
                    : "bg-white/5 text-white/70 border-white/15 hover:bg-white/10",
                ].join(" ")}
              >
                {p}
              </button>
            ))}
            <div className="relative ml-auto">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-white/50" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search e.g. 888431…"
                className="pl-8 pr-3 py-2 rounded-lg bg-white/5 border border-white/15 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
              />
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-auto p-3">
          {loading && (
            <div className="flex items-center gap-2 text-white/70 text-sm p-3">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your numbers…
            </div>
          )}
          {error && (
            <div className="text-rose-300 text-sm p-3">{error}</div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-white/60 text-sm p-3">No numbers match your filter.</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {filtered.map((n) => (
              <div
                key={n.id}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-3 flex items-center justify-between"
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm">{n.e164}</div>
                  <div className="text-[11px] text-white/60">
                    {n.messaging_profile_id ? "Profile linked" : "No profile on number"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => selectNumber(n)}
                  disabled={pendingId === n.id}
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
                >
                  {pendingId === n.id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Assigning…
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Select
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
