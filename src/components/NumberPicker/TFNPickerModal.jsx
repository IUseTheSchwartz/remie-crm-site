// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { X, ChevronLeft, ChevronRight, AlertTriangle, Check, Loader2 } from "lucide-react";

const TFN_PREFIXES = ["833", "844", "855", "866", "877", "888"]; // 800 removed

function cls(...xs) { return xs.filter(Boolean).join(" "); }

export default function TFNPickerModal({ userId, onPicked, onClose }) {
  const [prefix, setPrefix] = useState(TFN_PREFIXES[0]);
  const [page, setPage] = useState(1);
  const [limit] = useState(30);
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(null); // e164 being ordered
  const [error, setError] = useState(null);

  async function fetchPage({ pfx = prefix, pg = page }) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ prefix: pfx, page: String(pg), limit: String(limit) });
      const res = await fetch(`/.netlify/functions/tfn-search?` + qs.toString(), { method: "GET" });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `Search failed (${res.status})`);
        setItems([]);
        setMeta(null);
        return;
      }
      setItems(Array.isArray(data.items) ? data.items : []);
      setMeta(data.meta || null);
    } catch (e) {
      setError(e.message || "Search failed");
      setItems([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchPage({ pfx: prefix, pg: 1 }); setPage(1); }, [prefix]);
  useEffect(() => { fetchPage({ pfx: prefix, pg: page }); }, [page]);

  const canPrev = page > 1;
  const canNext = useMemo(() => {
    if (!meta || !meta.total_pages) return true;
    return page < (meta.total_pages || 9999);
  }, [meta, page]);

  async function selectNumber(n) {
    try {
      setError(null);
      setSelecting(n.phone_number);

      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token || null;

      const res = await fetch("/.netlify/functions/tfn-select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: `Bearer ${jwt}`, "X-Supabase-Auth": jwt } : {}),
        },
        body: JSON.stringify({
          e164: n.phone_number,
          telnyx_phone_id: n.id,
          user_id: userId || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setError(data.error || `Could not assign number (${res.status})`);
        return;
      }

      if (typeof onPicked === "function") onPicked(data.e164 || n.phone_number);
      if (typeof onClose === "function") onClose();
    } catch (e) {
      setError(e.message || "Selection failed");
    } finally {
      setSelecting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b12] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 p-3">
          <div>
            <div className="text-sm font-semibold">Choose a Toll-Free Number</div>
            <div className="text-xs text-white/60">Numbers are provided by Telnyx. Selecting will assign it to your messaging.</div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-white/15 bg-white/5 p-1.5 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Prefix tabs (800 removed) */}
        <div className="flex flex-wrap gap-2 border-b border-white/10 p-2">
          {TFN_PREFIXES.map((p) => (
            <button
              key={p}
              onClick={() => setPrefix(p)}
              className={cls(
                "rounded-md px-2 py-1 text-xs",
                prefix === p ? "bg-white/15 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-auto p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-white/70"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
          ) : error ? (
            <div className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-200 text-xs">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          ) : items.length === 0 ? (
            <div className="text-sm text-white/60">No numbers available for {prefix} right now. Try another prefix or page.</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {items.map((n) => (
                <div key={n.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] p-2">
                  <div>
                    <div className="font-mono text-sm">{n.phone_number}</div>
                    <div className="text-[11px] text-white/60">{n.country || "US"} {n.region ? `• ${n.region}` : ""}</div>
                  </div>
                  <button
                    disabled={!!selecting}
                    onClick={() => selectNumber(n)}
                    className={cls(
                      "inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[12px]",
                      selecting === n.phone_number ? "bg-white/10" : "bg-white/5 hover:bg-white/10"
                    )}
                  >
                    {selecting === n.phone_number ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Select
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer pagination */}
        <div className="flex items-center justify-between border-t border-white/10 p-2">
          <button
            disabled={!canPrev || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <div className="text-xs text-white/60">Page {page}{meta?.total_pages ? ` of ${meta.total_pages}` : ""}</div>
          <button
            disabled={!canNext || loading}
            onClick={() => setPage((p) => p + 1)}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}