// File: src/components/NumberCard.jsx
export default function NumberCard({ label, value, sublabel }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="text-xs uppercase tracking-wide text-white/60">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
      {sublabel && <div className="mt-1 text-sm text-white/60">{sublabel}</div>}
    </div>
  );
}
