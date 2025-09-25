import { useEffect, useState } from "react";
import { listMyNumbers, searchNumbersByAreaCode, purchaseNumber } from "../lib/numbers";
import { startCall, listMyCallLogs } from "../lib/calls";
import { supabase } from "../lib/supabaseClient";
import { Phone, Plus, Loader2, History } from "lucide-react";

export default function DialerPage() {
  const [agentCell, setAgentCell] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [myNumbers, setMyNumbers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [buyOpen, setBuyOpen] = useState(false);
  const [searchNPA, setSearchNPA] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    refreshNumbers();
    refreshLogs();
    primeAgentCell();
  }, []);

  async function primeAgentCell() {
    const { data } = await supabase.auth.getUser();
    const phone = data?.user?.user_metadata?.phone || ""; // adjust if you store in agent_profiles
    setAgentCell(phone);
  }

  async function refreshNumbers() {
    try { setMyNumbers(await listMyNumbers()); } catch {}
  }
  async function refreshLogs() {
    try { setLogs(await listMyCallLogs(100)); } catch {}
  }

  async function onCall() {
    if (!agentCell || !toNumber || myNumbers.length === 0) {
      alert("Add your phone and buy a number first.");
      return;
    }
    setBusy(true);
    try {
      await startCall({ agentNumber: normUS(agentCell), leadNumber: normUS(toNumber) });
      setTimeout(refreshLogs, 2500);
    } catch (e) {
      alert(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSearch() {
    try {
      setBusy(true);
      const res = await searchNumbersByAreaCode(searchNPA, 10);
      setSearchResults(res);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function onBuy(num) {
    try {
      setBusy(true);
      await purchaseNumber(num, { isFree: false });
      await refreshNumbers();
      alert(`Purchased ${num}`);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold">Dialer</h1>

      <div className="space-y-2">
        <label className="text-sm font-medium">Your phone (we call you first)</label>
        <input
          className="w-full border rounded-xl px-3 py-2"
          placeholder="+1 615 555 1234"
          value={agentCell}
          onChange={(e) => setAgentCell(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
        <div className="md:col-span-3">
          <label className="text-sm font-medium">Number to call</label>
          <input
            className="w-full border rounded-xl px-3 py-2"
            placeholder="+1 615 555 9876"
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value)}
          />
        </div>
        <button
          onClick={onCall}
          disabled={busy || !agentCell || !toNumber || myNumbers.length === 0}
          className="flex items-center justify-center gap-2 rounded-xl px-4 py-3 bg-black text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
          Call
        </button>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">My Numbers</h2>
          <button
            onClick={() => setBuyOpen((x) => !x)}
            className="ml-auto inline-flex items-center gap-2 rounded-xl px-3 py-2 border"
          >
            <Plus className="w-4 h-4" /> Buy another number
          </button>
        </div>

        <div className="border rounded-xl divide-y">
          {myNumbers.length === 0 && <div className="p-4 text-sm text-gray-500">No numbers yet.</div>}
          {myNumbers.map((n) => (
            <div key={n.id} className="p-3 text-sm flex items-center gap-3">
              <div className="font-mono">{n.telnyx_number}</div>
              {n.is_free && <span className="text-xs rounded bg-green-100 px-2 py-0.5">free</span>}
              <span className="text-xs text-gray-500">NPA {n.area_code}</span>
            </div>
          ))}
        </div>
      </section>

      {buyOpen && (
        <section className="space-y-3 border rounded-xl p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium">Search by area code</label>
              <input
                className="w-full border rounded-xl px-3 py-2"
                placeholder="615"
                value={searchNPA}
                onChange={(e) => setSearchNPA(e.target.value.replace(/\D+/g, "").slice(0, 3))}
              />
            </div>
            <button onClick={onSearch} className="rounded-xl px-4 py-2 border">Search</button>
          </div>

          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
            {searchResults.map((num) => (
              <div key={num} className="border rounded-xl p-3 flex items-center justify-between">
                <span className="font-mono">{num}</span>
                <button onClick={() => onBuy(num)} className="rounded-lg px-3 py-1 bg-black text-white">
                  Buy
                </button>
              </div>
            ))}
            {searchResults.length === 0 && <div className="text-sm text-gray-500">No results yet.</div>}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4" />
          <h2 className="text-lg font-semibold">Recent Calls</h2>
          <button onClick={refreshLogs} className="text-sm underline ml-auto">Refresh</button>
        </div>
        <div className="border rounded-xl divide-y">
          {logs.length === 0 && <div className="p-4 text-sm text-gray-500">No calls yet.</div>}
          {logs.map((c) => (
            <div key={c.id} className="p-3 text-sm grid grid-cols-2 md:grid-cols-6 gap-2">
              <div className="font-mono">{c.to_number}</div>
              <div className="font-mono">{c.from_number}</div>
              <div className="capitalize">{c.status || "-"}</div>
              <div>{fmt(c.started_at)}</div>
              <div>{c.duration_seconds ? `${c.duration_seconds}s` : "-"}</div>
              <div>{c.recording_url ? <a className="underline" href={c.recording_url} target="_blank">Recording</a> : "-"}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function normUS(s) {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s;
}
function fmt(s) { try { return new Date(s).toLocaleString(); } catch { return s || ""; } }
