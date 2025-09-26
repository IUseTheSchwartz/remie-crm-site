// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Loader2, X, Search } from "lucide-react";

const ALLOWED_PREFIXES = ["833", "844", "855", "866", "877", "888"];

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [prefix, setPrefix] = useState("888");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [orderingId, setOrderingId] = useState(null);
  const [successMsg, setSuccessMsg] = useState("");

  const title = useMemo(() => `Choose a Toll-Free Number`, []);

  async function load() {
    try {
      setLoading(true);
      setError("");
      setItems([]);

      const res = await fetch(
        `/.netlify/functions/tfn-search?prefix=${encodeURIComponent(prefix)}&limit=30&page=${page}`,
        { method: "GET" }
      );
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Search failed");
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, page]);

  async function getFreshAccessToken() {
    // Always try to refresh, then fall back to current
    try {
      const { data: refreshed } = await supabase.auth.refreshSession();
      const token = refreshed?.session?.access_token;
      if (token) return token;
    } catch {}
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function handleSelect(phoneId) {
    try {
      setOrderingId(phoneId);
      setError("");
      setSuccessMsg("");

      const accessToken = await getFreshAccessToken();
      if (!accessToken) {
        setError("You must be signed in.");
        setOrderingId(null);
        return;
      }

      const res = await fetch("/.netlify/functions/tfn-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Send token in Authorization header (server reads Bearer or cookie)
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ phone_id: phoneId }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        const detail = data?.detail || data?.error || "Order failed";
        setError(typeof detail === "string" ? detail : "Order failed");
        setOrderingId(null);
        return;
      }

      const e164 = data?.number?.phone_number || data?.phone_number || null;
      setSuccessMsg(`Number ${e164 || ""} assigned to your account.`);
      setOrderingId(null);

      if (typeof onPicked === "function" && e164) onPicked(e164);
      setTimeout(() => onClose?.(), 800);
    } catch (e) {
      setError(e.message || "Order failed");
      setOrderingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={() => onClose?.()}
            className="rounded-md border border-white/15 bg-white/5 p-1 hover:bg-white/10"
            aria-label="Close"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Prefix tabs (no 800) */}
        <div className="mb-3 flex flex-wrap gap-2">
          {ALLOWED_PREFIXES.map((p) => {
            const active = p === prefix;
            return (
              <button
                key={p}
                type="button"
                onClick={() => { setPrefix(p); setPage(1); }}
                className={[
                  "rounded-lg border px-3 py-1.5 text-sm",
                  active
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                    : "border-white/15 bg-white/5 text-white/80 hover:bg-white/10",
                ].join(" ")}
              >
                {p}
              </button>
            );
          })}
        </div>

        {/* Search status */}
        <div className="mb-3 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs text-white/60">
            <Search className="h-4 w-4" /> Showing {items.length} results for {prefix}
          </div>
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="text-xs text-white/60">Page {page}</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => setPage((n) => n + 1)}
              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
            >
              Next
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-400/10 p-2 text-xs text-rose-200">
            {error}
          </div>
        )}
        {successMsg && (
          <div className="mb-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-2 text-xs text-emerald-200">
            {successMsg}
          </div>
        )}

        {/* Results */}
        <div className="grid max-h-[50vh] grid-cols-1 gap-2 overflow-auto rounded-lg border border-white/10 p-2">
          {loading ? (
            <div className="flex items-center gap-2 text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : items.length === 0 ? (
            <div className="text-sm text-white/60">No numbers available for {prefix} right now. Try another prefix.</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="flex items-center justify-between rounded-md border border-white/10 bg-white/[0.02] p-2">
                <div className="text-sm">
                  <div className="font-medium">{it.phone_number}</div>
                  <div className="text-xs text-white/60">
                    {it.country || "US"} {it.region ? `• ${it.region}` : ""}
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => handleSelect(it.id)}
                    disabled={orderingId === it.id}
                    className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-50"
                  >
                    {orderingId === it.id ? "Selecting…" : "Select"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}