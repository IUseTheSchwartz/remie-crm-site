import { useEffect, useState } from "react";

const TELEPHONY = import.meta.env.PROD
  ? "https://<YOUR-PROJECT-REF>.functions.supabase.co/telephony"
  : "/api/telephony";

const tenantId = () => localStorage.getItem("tenant_id") || "demo-tenant"; // replace with real tenant resolution
const headers = () => ({ "x-tenant-id": tenantId() });

export default function SettingsPhoneSetup() {
  const [status, setStatus] = useState({ status: "none" });
  const [area, setArea] = useState("");
  const [searching, setSearching] = useState(false);
  const [numbers, setNumbers] = useState([]);
  const [selectNum, setSelectNum] = useState("");
  const [buying, setBuying] = useState(false);

  async function loadStatus() {
    const r = await fetch(`${TELEPHONY}/status`, { headers: headers() });
    const j = await r.json();
    setStatus(j);
  }

  async function search() {
    if (!area) return;
    setSearching(true);
    try {
      const r = await fetch(`${TELEPHONY}/search?areaCode=${encodeURIComponent(area)}`, { headers: headers() });
      const j = await r.json();
      setNumbers(j || []);
    } finally {
      setSearching(false);
    }
  }

  async function buy() {
    if (!selectNum) return;
    setBuying(true);
    try {
      const r = await fetch(`${TELEPHONY}/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ phone_number: selectNum }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      await loadStatus();
      alert("Number ready! Your Messages tab is now enabled.");
    } catch (e) {
      alert(`Buy failed: ${e.message}`);
    } finally {
      setBuying(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  return (
    <div className="mx-auto max-w-2xl text-white">
      <h1 className="text-2xl font-semibold">Phone Setup</h1>
      <p className="mt-1 text-sm text-white/70">Connect a number for client texting.</p>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-sm">
          <div><span className="text-white/60">Status:</span> <b>{status?.status || "none"}</b></div>
          {status?.phone_number && (
            <div className="mt-1"><span className="text-white/60">Number:</span> {status.phone_number}</div>
          )}
          {status?.status_note && (
            <div className="mt-1 text-white/60">{status.status_note}</div>
          )}
        </div>
      </div>

      {status?.status !== "ready" && (
        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-lg font-semibold">Get a new number</h2>
          <p className="mt-1 text-sm text-white/70">Search by area code, pick a number, and we’ll activate it.</p>
          <div className="mt-3 flex gap-2">
            <input
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="Area code (e.g. 615)"
              className="w-40 rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
            />
            <button
              onClick={search}
              disabled={searching || !area}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>

          {!!numbers.length && (
            <div className="mt-4 space-y-2">
              {numbers.map((n) => (
                <label key={n.number} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
                  <input
                    type="radio"
                    name="num"
                    value={n.number}
                    checked={selectNum === n.number}
                    onChange={() => setSelectNum(n.number)}
                  />
                  <div>
                    <div className="text-sm font-medium">{n.friendly || n.number}</div>
                    <div className="text-xs text-white/60">{n.locality || "—"} {n.region ? `(${n.region})` : ""}</div>
                  </div>
                </label>
              ))}
              <button
                onClick={buy}
                disabled={buying || !selectNum}
                className="mt-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
              >
                {buying ? "Buying…" : "Buy & Activate"}
              </button>
            </div>
          )}
        </div>
      )}

      {status?.status === "ready" && (
        <div className="mt-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
          ✅ Your texting number is ready. You can now use the <b>Messages</b> tab.
        </div>
      )}
    </div>
  );
}
