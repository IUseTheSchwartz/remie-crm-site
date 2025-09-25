import { useEffect, useMemo, useState } from "react";
import {
  Phone,
  PhoneCall,
  History,
  Plus,
  Search,
  X,
  Loader2,
  Sparkles,
  Shield,
  BadgeCheck,
} from "lucide-react";
import { listMyNumbers, searchNumbersByAreaCode, purchaseNumber } from "../lib/numbers";
import { startCall, listMyCallLogs } from "../lib/calls";
import { supabase } from "../lib/supabaseClient";

/** Small helpers */
const fmt = (s) => { try { return new Date(s).toLocaleString(); } catch { return s || ""; } };
const normUS = (s) => {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s;
};

export default function DialerPage() {
  /* ---------- state ---------- */
  const [agentCell, setAgentCell] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [myNumbers, setMyNumbers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);

  // buy modal
  const [openBuy, setOpenBuy] = useState(false);
  const [npa, setNpa] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  /* ---------- effects ---------- */
  useEffect(() => {
    refreshNumbers();
    refreshLogs();
    primeAgentCell();
  }, []);

  async function primeAgentCell() {
    const { data } = await supabase.auth.getUser();
    // adjust if you store the cell on your profile table
    const phone = data?.user?.user_metadata?.phone || "";
    setAgentCell(phone);
  }

  async function refreshNumbers() {
    try { setMyNumbers(await listMyNumbers()); } catch { /* ignore */ }
  }
  async function refreshLogs() {
    try { setLogs(await listMyCallLogs(100)); } catch { /* ignore */ }
  }

  /* ---------- actions ---------- */
  async function onCall() {
    if (!agentCell) return alert("Add your phone first (we call you there).");
    if (!toNumber) return alert("Enter a number to call.");
    if (myNumbers.length === 0) return alert("You don’t own any numbers yet. Buy one to place calls.");
    setBusy(true);
    try {
      await startCall({ agentNumber: normUS(agentCell), leadNumber: normUS(toNumber) });
      // give the webhook a moment to write logs
      setTimeout(refreshLogs, 2000);
    } catch (e) {
      alert(e.message || "Failed to start call");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!npa || npa.length !== 3) return;
    try {
      setSearching(true);
      const nums = await searchNumbersByAreaCode(npa, 12);
      setResults(nums);
    } catch (e) {
      alert(e.message || "Search failed");
    } finally {
      setSearching(false);
    }
  }

  async function buyNumber(num) {
    try {
      setBusy(true);
      await purchaseNumber(num, { isFree: false });
      await refreshNumbers();
      alert(`Purchased ${num}`);
      setOpenBuy(false);
      setResults([]);
    } catch (e) {
      alert(e.message || "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- computed ---------- */
  const hasNumber = myNumbers.length > 0;

  /* ---------- UI ---------- */
  return (
    <div className="relative">
      {/* subtle hero gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-24 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-full blur-3xl opacity-40"
             style={{ background:
               "radial-gradient(40rem 20rem at 30% 30%, rgba(99,102,241,.35), transparent), radial-gradient(40rem 20rem at 70% 40%, rgba(217,70,239,.25), transparent)"}}
        />
      </div>

      {/* header */}
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/80 to-fuchsia-500/80 text-white shadow-lg">
            <PhoneCall className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dialer</h1>
            <p className="text-sm text-white/60">Local-presence calling with your owned numbers.</p>
          </div>
        </div>
      </header>

      {/* main grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* left: call composer */}
        <section className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Call composer</h2>
            <div className="flex items-center gap-2 text-xs text-white/50">
              <Shield className="h-4 w-4" /> STIR/SHAKEN attested via your Telnyx DIDs
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-5">
            <div className="sm:col-span-5">
              <Label> Your phone (we call you first) </Label>
              <Input
                placeholder="+1 615 555 1234"
                value={agentCell}
                onChange={(e) => setAgentCell(e.target.value)}
              />
            </div>

            <div className="sm:col-span-4">
              <Label> Number to call </Label>
              <Input
                placeholder="+1 615 555 9876"
                value={toNumber}
                onChange={(e) => setToNumber(e.target.value)}
              />
            </div>

            <div className="sm:col-span-1 flex items-end">
              <Button
                onClick={onCall}
                disabled={busy || !agentCell || !toNumber || !hasNumber}
                className="w-full"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                <span>Call</span>
              </Button>
            </div>
          </div>

          {/* quick tips */}
          {!hasNumber && (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-100/10 px-3 py-2 text-amber-200">
              <Sparkles className="h-4 w-4" />
              <span>You need at least one number to place calls. Buy one below.</span>
            </div>
          )}
        </section>

        {/* right: my numbers card */}
        <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-medium">My numbers</h2>
            <button
              onClick={() => setOpenBuy(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
            >
              <Plus className="h-4 w-4" />
              Buy number
            </button>
          </div>

          <div className="space-y-2">
            {myNumbers.length === 0 && (
              <EmptyCard text="No numbers yet." />
            )}

            {myNumbers.map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <BadgeCheck className="h-4 w-4 text-emerald-300/80" />
                  <div className="font-mono text-sm">{n.telnyx_number}</div>
                </div>
                <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-white/70">
                  NPA {n.area_code}{n.is_free ? " • free" : ""}
                </span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] text-white/50">
            We’ll automatically match the lead’s area code when possible, or use the closest area code you own.
          </p>
        </section>
      </div>

      {/* logs */}
      <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-5 w-5" />
          <h2 className="text-lg font-medium">Recent calls</h2>
          <button onClick={refreshLogs} className="ml-auto text-sm underline opacity-80 hover:opacity-100">
            Refresh
          </button>
        </div>

        {logs.length === 0 ? (
          <EmptyCard text="No calls yet." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="min-w-full text-sm">
              <thead className="bg-white/5 text-white/70">
                <tr>
                  <Th>To</Th>
                  <Th>From (caller ID)</Th>
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th>Recording</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 bg-black/20">
                {logs.map((c) => (
                  <tr key={c.id} className="hover:bg-white/5">
                    <Td mono>{c.to_number}</Td>
                    <Td mono>{c.from_number}</Td>
                    <Td>
                      <StatusBadge status={c.status} />
                    </Td>
                    <Td>{fmt(c.started_at)}</Td>
                    <Td>{c.duration_seconds ? `${c.duration_seconds}s` : "-"}</Td>
                    <Td>
                      {c.recording_url ? (
                        <a className="underline" href={c.recording_url} target="_blank" rel="noreferrer">
                          Listen
                        </a>
                      ) : (
                        "-"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* buy modal */}
      {openBuy && (
        <Modal onClose={() => setOpenBuy(false)} title="Buy a number">
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label>Search by area code</Label>
                <Input
                  placeholder="615"
                  value={npa}
                  onChange={(e) => setNpa(e.target.value.replace(/\D+/g, "").slice(0, 3))}
                />
              </div>
              <Button onClick={runSearch} disabled={searching || npa.length !== 3}>
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span>Search</span>
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {results.map((num) => (
                <div
                  key={num}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2"
                >
                  <div className="font-mono">{num}</div>
                  <Button onClick={() => buyNumber(num)} intent="secondary" size="sm">
                    Buy
                  </Button>
                </div>
              ))}
              {results.length === 0 && !searching && (
                <EmptyCard text="No results yet. Try a different area code." compact />
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------- tiny UI primitives (tailwind-only) ---------- */

function Label({ children }) {
  return <label className="mb-1 block text-xs font-medium tracking-wide text-white/70">{children}</label>;
}

function Input(props) {
  return (
    <input
      {...props}
      className={[
        "w-full rounded-xl bg-black/30 border border-white/10",
        "px-3 py-2 outline-none text-sm",
        "placeholder:text-white/40",
        "focus:ring-2 focus:ring-indigo-500/40 focus:border-white/20",
      ].join(" ")}
    />
  );
}

function Button({ children, intent = "primary", size = "md", className = "", ...rest }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl transition disabled:opacity-60 disabled:cursor-not-allowed";
  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2",
    lg: "px-5 py-3 text-base",
  };
  const intents = {
    primary:
      "text-white bg-gradient-to-br from-indigo-500/90 to-fuchsia-500/90 hover:from-indigo-500 hover:to-fuchsia-500 shadow-lg shadow-fuchsia-500/10",
    secondary:
      "text-white bg-white/10 hover:bg-white/15 border border-white/15",
  };
  return (
    <button className={`${base} ${sizes[size]} ${intents[intent]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

function Th({ children }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}
function Td({ children, mono = false }) {
  return (
    <td className={`px-3 py-2 ${mono ? "font-mono" : ""}`}>
      {children}
    </td>
  );
}

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  const styles = {
    queued: "bg-sky-500/15 text-sky-300",
    ringing: "bg-amber-500/15 text-amber-300",
    answered: "bg-emerald-500/15 text-emerald-300",
    completed: "bg-indigo-500/15 text-indigo-300",
    failed: "bg-rose-500/15 text-rose-300",
  };
  const cls = styles[s] || "bg-white/10 text-white/70";
  return <span className={`rounded-md px-2 py-0.5 text-xs ${cls}`}>{status || "-"}</span>;
}

/* very light-weight modal */
function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-950 p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-white/70 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EmptyCard({ text, compact = false }) {
  return (
    <div
      className={`rounded-xl border border-white/10 bg-black/20 text-sm text-white/60 ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      {text}
    </div>
  );
}
