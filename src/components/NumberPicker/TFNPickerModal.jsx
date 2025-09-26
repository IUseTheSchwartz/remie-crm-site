// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Loader2, X } from "lucide-react";

const PREFIXES = ["833","844","855","866","877","888"]; // 🚫 no 800

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [prefix, setPrefix] = useState("833");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState("");

  const title = useMemo(() => `Choose a Toll-Free Number (${prefix})`, [prefix]);

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/tfn-search?prefix=${encodeURIComponent(prefix)}&limit=30&page=${page}`);
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || "Search failed");
      setItems(data.items || []);
    } catch (e) {
      setErr(e.message || "Failed to load numbers");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [prefix, page]);

  async function selectNumber(n) {
    setErr("");
    try {
      // Get current session token for backend auth
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token || null;

      const res = await fetch("/.netlify/functions/tfn-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          user_id: userId,                 // also include explicitly
          telnyx_phone_id: n.id,           // the Telnyx phone id from search
          e164: n.phone_number,            // E.164
        }),
      });

      const out = await res.json();
      if (!res.ok || out?.error) {
        // surface Telnyx assign/order issues but keep user informed
        const msg = out?.error || out?.note || "Purchase failed";
        throw new Error(msg);
      }

      // If order succeeded or number already owned, we still inserted into DB.
      if (typeof onPicked === "function") onPicked(n.phone_number);
      if (typeof onClose === "function") onClose();

      // Optional: toast the assignment note if needed
      // e.g., if (!out.assign?.ok) showToast("Number saved. Please attach profile in Telnyx.");
    } catch (e) {
      setErr(e.message || "Could not purchase number");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0b0b12] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md border border-white/15 bg-white/5 p-1 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Prefix chips */}
        <div className="mb-3 flex flex-wrap gap-2">
          {PREFIXES.map((p) => (
            <button
              key={p}
              onClick={() => { setPage(1); setPrefix(p); }}
              className={[
                "rounded-md border px-3 py-1 text-sm",
                p === prefix
                  ? "border-emerald-400/40 bg-emerald-400/10"
                  : "border-white/15 bg-white/5 hover:bg-white/10",
              ].join(" ")}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading numbers…
            </div>
          ) : err ? (
            <div className="text-rose-300 text-sm">{err}</div>
          ) : items.length === 0 ? (
            <div className="text-white/70 text-sm">No numbers available for {prefix} right now. Try another prefix.</div>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {items.map((n) => (
                <li key={n.id} className="flex items-center justify-between rounded-md border border-white/10 bg-white/[0.02] p-2">
                  <div className="text-sm font-mono">{n.phone_number}</div>
                  <button
                    className="rounded-md border border-white/15 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
                    onClick={() => selectNumber(n)}
                  >
                    Select
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Simple paging (optional; Telnyx rotates inventory) */}
          <div className="mt-3 flex items-center justify-between text-xs text-white/70">
            <button
              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 hover:bg-white/10 disabled:opacity-40"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <div>Page {page}</div>
            <button
              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 hover:bg-white/10 disabled:opacity-40"
              disabled={loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>

        <div className="mt-2 text-[11px] text-white/50">
          Numbers are provisioned via Telnyx. 800-prefix is excluded for cost reasons.
        </div>
      </div>
    </div>
  );
}