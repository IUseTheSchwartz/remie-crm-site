// File: src/pages/DialerPage.jsx
import { useEffect, useState, useRef } from "react";
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
  CheckCircle2,
} from "lucide-react";
import { listMyNumbers, searchNumbersByAreaCode, purchaseNumber } from "../lib/numbers";
import { startCall, listMyCallLogs } from "../lib/calls";
import { getMyBalanceCents, formatUSD } from "../lib/wallet";
import { supabase } from "../lib/supabaseClient";

/* ===== Maintenance toggle (add-only) ===== */
const DIALER_UNDER_MAINTENANCE = false; // <-- set to true to show the maintenance screen

/* ------- config & small helpers ------- */
const PRICE_CENTS = 500;                 // $5.00 after freebies
const FREE_NUMBERS = 5;                  // first 5 numbers are free
const COST_PER_SEGMENT_CENTS =
  Number(import.meta.env?.VITE_COST_PER_SEGMENT_CENTS ?? 1); // default 1¢ per started min

const rateLabel = `$${(COST_PER_SEGMENT_CENTS / 100).toFixed(2)}/min (per started min)`;

const fmt = (s) => { try { return new Date(s).toLocaleString(); } catch { return s || ""; } };
const normUS = (s) => {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s;
};
const startedMinuteSegments = (seconds) => Math.max(1, Math.ceil((Number(seconds) || 0) / 60));

export default function DialerPage() {
  /* ===== Early return for maintenance (add-only) ===== */
  if (DIALER_UNDER_MAINTENANCE) {
    return (
      <div className="relative min-h-[70vh]">
        {/* subtle hero gradient (matches your style) */}
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute -top-24 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-full blur-3xl opacity-40"
            style={{
              background:
                "radial-gradient(40rem 20rem at 30% 30%, rgba(99,102,241,.35), transparent), radial-gradient(40rem 20rem at 70% 40%, rgba(217,70,239,.25), transparent)",
            }}
          />
        </div>

        <div className="grid place-items-center h-full py-16">
          <div className="text-center max-w-xl">
            <h1 className="text-2xl font-semibold mb-2">Sorry — Under Maintenance</h1>
            <p className="text-white/70 mb-6">
              The Dialer page is temporarily unavailable while we make updates.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.history.back()}
                className="rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                Go Back
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-xl text-white bg-gradient-to-br from-indigo-500/90 to-fuchsia-500/90 hover:from-indigo-500 hover:to-fuchsia-500 px-4 py-2 text-sm shadow-lg shadow-fuchsia-500/10"
              >
                Refresh
              </button>
            </div>
            <p className="mt-4 text-xs text-white/60">Thanks for your patience—check back soon.</p>
          </div>
        </div>
      </div>
    );
  }

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

  // confirm purchase modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedNum, setSelectedNum] = useState("");
  const [balanceCents, setBalanceCents] = useState(0);

  // profile phone save state
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneSavedAt, setPhoneSavedAt] = useState(0);
  const lastLoadedPhoneRef = useRef("");

  // 🔊 recording preference (from call_recording_settings)
  const [recordEnabled, setRecordEnabled] = useState(false);
  const [savingRecordPref, setSavingRecordPref] = useState(false);

  /* ---------- computed ---------- */
  const freebiesLeft = Math.max(0, FREE_NUMBERS - (myNumbers?.length || 0));
  const hasNumber = (myNumbers?.length || 0) > 0;

  /* ---------- effects ---------- */
  useEffect(() => {
    refreshNumbers();
    refreshLogs();
    loadAgentPhone();
    refreshBalance();
    loadRecordingPref();
  }, []);

  async function refreshBalance() {
    try {
      const b = await getMyBalanceCents();
      setBalanceCents(b || 0);
    } catch {}
  }

  async function loadAgentPhone() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;

    const { data: row } = await supabase
      .from("agent_profiles")
      .select("phone")
      .eq("user_id", uid)
      .maybeSingle();

    const phone = row?.phone || "";
    lastLoadedPhoneRef.current = phone;
    setAgentCell(phone);
  }

  async function saveAgentPhoneIfChanged() {
    const next = agentCell?.trim();
    const prev = lastLoadedPhoneRef.current?.trim();
    if (next === prev) return;

    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;

    setSavingPhone(true);
    try {
      const { data: updated, error: upErr } = await supabase
        .from("agent_profiles")
        .update({ phone: next || null })
        .eq("user_id", uid)
        .select("user_id");
      if (upErr) throw upErr;

      if (!updated || updated.length === 0) {
        const { error: insErr } = await supabase
          .from("agent_profiles")
          .insert({ user_id: uid, phone: next || null });
        if (insErr) throw insErr;
      }

      lastLoadedPhoneRef.current = next || "";
      setPhoneSavedAt(Date.now());
    } catch (e) {
      console.error("Failed to save phone", e);
    } finally {
      setSavingPhone(false);
    }
  }

  async function loadRecordingPref() {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;
      const { data } = await supabase
        .from("call_recording_settings")
        .select("record_outbound_enabled")
        .eq("user_id", uid)
        .maybeSingle();
      setRecordEnabled(!!data?.record_outbound_enabled);
    } catch (e) {
      console.error("load record pref failed:", e);
    }
  }

  async function saveRecordingPref(checked) {
    try {
      setSavingRecordPref(true);
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;
      await supabase
        .from("call_recording_settings")
        .upsert({ user_id: uid, record_outbound_enabled: !!checked });
      setRecordEnabled(!!checked);
    } catch (e) {
      console.error("save record pref failed:", e);
      // revert optimistic UI if needed
    } finally {
      setSavingRecordPref(false);
    }
  }

  async function refreshNumbers() {
    try { setMyNumbers(await listMyNumbers()); } catch {}
  }
  async function refreshLogs() {
    try { setLogs(await listMyCallLogs(100)); } catch {}
  }

  /* ---------- actions ---------- */
  async function onCall() {
    if (!agentCell) return alert("Add your phone first (we call you there).");
    if (!toNumber) return alert("Enter a number to call.");
    if (!hasNumber) return alert("You don’t own any numbers yet. Buy one to place calls.");
    setBusy(true);
    try {
      await startCall({ agentNumber: normUS(agentCell), leadNumber: normUS(toNumber) });
      setTimeout(refreshLogs, 2000); // allow webhook to log
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

  // Confirm purchase (server enforces freebies + charges wallet if needed)
  async function confirmPurchase() {
    const isFree = freebiesLeft > 0;
    if (!isFree && balanceCents < PRICE_CENTS) {
      alert("You need at least $5.00 (500 cents) to buy another number.");
      return;
    }
    setBusy(true);
    try {
      const res = await purchaseNumber(selectedNum); // server returns { charged_cents, ... }
      const charged = typeof res?.charged_cents === "number" ? res.charged_cents : null;
      const left = typeof res?.freebies_left_after === "number" ? res.freebies_left_after : null;

      if (charged === 0) {
        alert(`Number purchased: ${selectedNum} (free)${left !== null ? ` • Free left: ${left}` : ""}`);
      } else if (charged > 0) {
        alert(`Number purchased: ${selectedNum}. Charged ${charged}¢${left !== null ? ` • Free left: ${left}` : ""}`);
      } else {
        alert(`Number purchased: ${selectedNum}.`);
      }

      await refreshNumbers();
      await refreshBalance();
      setConfirmOpen(false);
      setOpenBuy(false);
      setResults([]);
    } catch (e) {
      alert(e.message || "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- UI ---------- */
  return (
    <div className="relative">
      {/* subtle hero gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute -top-24 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-full blur-3xl opacity-40"
          style={{
            background:
              "radial-gradient(40rem 20rem at 30% 30%, rgba(99,102,241,.35), transparent), radial-gradient(40rem 20rem at 70% 40%, rgba(217,70,239,.25), transparent)",
          }}
        />
      </div>

      {/* top pills: Balance + Rate + Recording toggle */}
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-xs">
        <span className="rounded-md border border-white/10 bg-white/10 px-2 py-1">
          Balance: {formatUSD(balanceCents)} ({balanceCents}¢)
        </span>
        <span className="rounded-md border border-white/10 bg-white/10 px-2 py-1">
          Rate: {rateLabel}
        </span>

        <label className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/10 px-2 py-1 cursor-pointer">
          <input
            type="checkbox"
            checked={recordEnabled}
            onChange={(e) => saveRecordingPref(e.target.checked)}
            disabled={savingRecordPref}
          />
          <span>
            Record calls {recordEnabled ? "(2¢/min)" : "(1¢/min)"}
          </span>
          {savingRecordPref ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        </label>
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
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label>Your phone (we call you first)</Label>
                  <Input
                    placeholder="+1 615 555 1234"
                    value={agentCell}
                    onChange={(e) => setAgentCell(e.target.value)}
                    onBlur={saveAgentPhoneIfChanged}
                  />
                </div>
                {/* save state */}
                <div className="pb-1 text-xs min-w-[110px] text-right">
                  {savingPhone ? (
                    <span className="inline-flex items-center gap-1 text-white/70">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
                    </span>
                  ) : phoneSavedAt ? (
                    <span className="inline-flex items-center gap-1 text-emerald-300/80">
                      <CheckCircle2 className="h-4 w-4" /> Saved
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="sm:col-span-4">
              <Label>Number to call</Label>
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

          {!hasNumber && (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-100/10 px-3 py-2 text-amber-200">
              <Sparkles className="h-4 w-4" />
              <span>You need at least one number to place calls. Buy one below.</span>
            </div>
          )}
        </section>

        {/* right: my numbers */}
        <section className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">My numbers</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${freebiesLeft > 0
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-white/10 text-white/60"}`}
                title={`First ${FREE_NUMBERS} numbers are free`}
              >
                Free left: {freebiesLeft}
              </span>
            </div>
            <button
              onClick={() => setOpenBuy(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
            >
              <Plus className="h-4 w-4" />
              Buy number
            </button>
          </div>

          <div className="space-y-2">
            {myNumbers.length === 0 && <EmptyCard text="No numbers yet." />}

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
            First {FREE_NUMBERS} numbers are free. We’ll automatically match the lead’s area code when possible, or use the closest area code you own.
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
                  <Th>Charge</Th>
                  <Th>Recording</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 bg-black/20">
                {logs.map((c) => {
                  const status = (c.status || "").toLowerCase();
                  const billable = status === "completed" || status === "answered" || status === "bridged";
                  const cents = billable && c.duration_seconds > 0
                    ? startedMinuteSegments(c.duration_seconds) * COST_PER_SEGMENT_CENTS
                    : null;

                  return (
                    <tr key={c.id} className="hover:bg-white/5">
                      <Td mono>{c.to_number}</Td>
                      <Td mono>{c.from_number}</Td>
                      <Td><StatusBadge status={c.status} /></Td>
                      <Td>{fmt(c.started_at)}</Td>
                      <Td>{c.duration_seconds ? `${c.duration_seconds}s` : "-"}</Td>
                      <Td>{cents != null ? formatUSD(cents) : "-"}</Td>
                      <Td>
                        {c.recording_url ? (
                          <a className="underline" href={c.recording_url} target="_blank" rel="noreferrer" download={`call-${c.id || "recording"}.mp3`}>
                            Listen
                          </a>
                        ) : "-"}
                      </Td>
                    </tr>
                  );
                })}
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
                <div key={num} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                  <div className="font-mono">{num}</div>
                  <Button
                    onClick={() => { setSelectedNum(num); setConfirmOpen(true); }}
                    intent="secondary"
                    size="sm"
                  >
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

      {/* confirm purchase modal */}
      {confirmOpen && (
        <Modal onClose={() => setConfirmOpen(false)} title="Confirm purchase">
          <div className="space-y-3 text-sm">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 font-mono">{selectedNum}</div>

            <PurchaseDetails
              myNumbers={myNumbers}
              balanceCents={balanceCents}
            />

            <div className="flex gap-2 pt-2">
              <Button
                onClick={confirmPurchase}
                disabled={busy}
                className="flex-1"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Confirm
              </Button>
              <Button intent="secondary" onClick={() => setConfirmOpen(false)} className="flex-1">
                Cancel
              </Button>
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
  const sizes = { sm: "px-3 py-1.5 text-sm", md: "px-4 py-2", lg: "px-5 py-3 text-base" };
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
function Th({ children }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children, mono = false }) { return <td className={`px-3 py-2 ${mono ? "font-mono" : ""}`}>{children}</td>; }
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
    <div className={`rounded-xl border border-white/10 bg-black/20 text-sm text-white/60 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      {text}
    </div>
  );
}

/* ---------- helper component ---------- */
function PurchaseDetails({ myNumbers, balanceCents }) {
  const freebiesLeft = Math.max(0, FREE_NUMBERS - (myNumbers?.length || 0));
  const isFree = freebiesLeft > 0;

  if (isFree) {
    return (
      <div className="text-white/80">
        <div><strong>Price:</strong> $0.00 <span className="text-white/60">(you have {freebiesLeft} free {freebiesLeft === 1 ? "number" : "numbers"} left)</span></div>
        <div><strong>Your balance:</strong> {formatUSD(balanceCents)} ({balanceCents} cents)</div>
      </div>
    );
  }
  return (
    <div className="text-white/80">
      <div><strong>Price:</strong> $5.00 (500 cents)</div>
      <div><strong>Your balance:</strong> {formatUSD(balanceCents)} ({balanceCents} cents)</div>
      {balanceCents < PRICE_CENTS && (
        <div className="mt-2 rounded-md bg-amber-100/10 border border-amber-200/20 px-2 py-1 text-amber-200">
          You don’t have enough credits. Please top up to continue.
        </div>
      )}
      <p className="mt-2 text-xs text-white/60">
        By confirming, you agree to deduct 500 cents ($5.00) from your CRM balance to purchase this number.
      </p>
    </div>
  );
}
