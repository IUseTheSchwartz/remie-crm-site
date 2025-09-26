// File: src/components/NumberPicker/TFNPickerModal.jsx
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const PREFIXES = ["833", "844", "855", "866", "877", "888"]; // no 800

export default function TFNPickerModal({ userId, onClose, onPicked }) {
  const [prefix, setPrefix] = useState(PREFIXES[0]);
  const [loading, setLoading] = useState(false);
  const [orderingId, setOrderingId] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");

  async function fetchNumbers(pfx) {
    setLoading(true);
    setErr("");
    try {
      const url = new URL("/.netlify/functions/tfn-search", window.location.origin);
      url.searchParams.set("prefix", pfx);
      url.searchParams.set("limit", "30");
      const res = await fetch(url.toString(), { method: "GET" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || "Search failed");
      }
      setItems(json.items || []);
    } catch (e) {
      setErr(e.message || String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchNumbers(prefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix]);

  async function handleSelect(item) {
    if (!item?.id) {
      setErr("Missing phone_id from search result.");
      return;
    }
    if (orderingId) return; // prevent double clicks
    setOrderingId(item.id);
    setErr("");

    try {
      // get the current access token for Authorization
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const res = await fetch("/.netlify/functions/tfn-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ phone_id: item.id }), // <-- IMPORTANT
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        const msg =
          json?.error === "telnyx_order_failed"
            ? "Telnyx refused the order for this number."
            : json?.error || "Order failed";
        throw new Error(msg);
      }

      // success: update parent with the E.164 so the page shows it immediately
      const e164 = json?.number?.phone_number || item.phone_number || null;
      if (onPicked && e164) onPicked(e164);
      onClose?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setOrderingId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
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
          <div className="flex flex-wrap gap-2">
            {PREFIXES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPrefix(p)}
                className={[
                  "rounded-md border px-2 py-1 text-xs",
                  prefix === p
                    ? "border-emerald-400/40 bg-emerald-400/10"
                    : "border-white/15 bg-white/5 hover:bg-white/10",
                ].join(" ")}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => fetchNumbers(prefix)}
            className="ml-auto rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
          >
            Refresh
          </button>
        </div>

        {err && (
          <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-400/10 p-2 text-xs text-rose-200">
            {err}
          </div>
        )}

        <div className="max-h-[50vh] overflow-auto rounded-md border border-white/10">
          {loading ? (
            <div className="grid place-items-center p-6 text-sm text-white/70">Loading…</div>
          ) : items.length === 0 ? (
            <div className="grid place-items-center p-6 text-sm text-white/60">
              No numbers available for {prefix} right now.
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-white/60">
                  <th className="px-3 py-2">Number</th>
                  <th className="px-3 py-2">Country</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b border-white/10">
                    <td className="px-3 py-2">{it.phone_number}</td>
                    <td className="px-3 py-2">{it.country || "US"}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        disabled={orderingId === it.id}
                        onClick={() => handleSelect(it)}
                        className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-60"
                        title="Purchase & assign to your messaging profile"
                      >
                        {orderingId === it.id ? "Selecting…" : "Select"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-2 text-[11px] text-white/50">
          Only prefixes 833/844/855/866/877/888 are shown (800 excluded).
        </div>
      </div>
    </div>
  );
}