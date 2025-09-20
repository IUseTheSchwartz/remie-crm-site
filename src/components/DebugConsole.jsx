import { useEffect, useState } from "react";
import { debug } from "../lib/debug";

export default function DebugConsole() {
  const [open, setOpen] = useState(debug.enabled());
  const [rows, setRows] = useState(debug.get());

  useEffect(() => {
    const t = setInterval(() => setRows(debug.get()), 400);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { if (debug.enabled() !== open) setOpen(debug.enabled()); }, [open]);

  const copy = async () => {
    const text = rows.map(r => `[${r.ts}] ${r.type.toUpperCase()} ${JSON.stringify(r.args)}`).join("\n");
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  if (!open) {
    return (
      <button
        onClick={() => { debug.on(); setOpen(true); }}
        className="fixed bottom-4 right-4 z-50 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-xs"
      >
        Open Debug
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(92vw,640px)] overflow-hidden rounded-2xl border border-white/20 bg-black/80 backdrop-blur">
      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <div className="font-semibold">Debug Console</div>
        <div className="flex items-center gap-2">
          <button onClick={copy} className="rounded border border-white/20 px-2 py-1">Copy</button>
          <button onClick={() => debug.clear()} className="rounded border border-white/20 px-2 py-1">Clear</button>
          <button onClick={() => { debug.off(); setOpen(false); }} className="rounded border border-white/20 px-2 py-1">Close</button>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-auto px-3 pb-3 text-[11px] leading-relaxed">
        {rows.length === 0 && <div className="opacity-60">No logs yet. Try adding a lead.</div>}
        {rows.map((r, i) => (
          <div key={i} className={`mb-1 ${r.type === "error" ? "text-rose-300" : r.type === "warn" ? "text-amber-300" : "text-white/90"}`}>
            <span className="opacity-60">[{new Date(r.ts).toLocaleTimeString()}]</span>{" "}
            <span className="opacity-80">{r.type.toUpperCase()}</span>{" "}
            <code className="opacity-90">{r.args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
