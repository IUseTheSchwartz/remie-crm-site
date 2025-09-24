// File: src/pages/AdminConsole.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import useIsAdminAllowlist from "../hooks/useIsAdminAllowlist.js";

function centsToUsd(cents) {
  if (cents == null || Number.isNaN(cents)) return "0.00";
  return (Number(cents) / 100).toFixed(2);
}
function usdToCents(usdStr) {
  const n = Number(String(usdStr).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

export default function AdminConsole() {
  const { isAdmin, loading } = useIsAdminAllowlist();
  const [rows, setRows] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // ---- fetch users from your profiles table ----
  async function load() {
    setFetching(true);
    setErr("");
    try {
      // Adjust columns/table names to match your schema
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, seats, balance_cents, templates_locked, created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setErr(e.message || "Failed to load users");
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  // ---- optimistic update helper ----
  function patchRow(id, patch) {
    setRows((prev) => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }

  // ---- persist changes for a single user ----
  async function saveRow(row) {
    setSaving(true);
    setErr("");
    try {
      const update = {
        seats: Number(row.seats) || 0,
        balance_cents: Number(row.balance_cents) || 0,
        templates_locked: !!row.templates_locked,
      };
      const { error } = await supabase
        .from("profiles")
        .update(update)
        .eq("id", row.id);
      if (error) throw error;
    } catch (e) {
      setErr(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // ---- bulk save all visible rows (optional) ----
  async function saveAll() {
    setSaving(true);
    setErr("");
    try {
      const updates = rows.map(r => ({
        id: r.id,
        seats: Number(r.seats) || 0,
        balance_cents: Number(r.balance_cents) || 0,
        templates_locked: !!r.templates_locked,
      }));
      const { error } = await supabase.from("profiles").upsert(updates);
      if (error) throw error;
    } catch (e) {
      setErr(e.message || "Failed to save all");
    } finally {
      setSaving(false);
    }
  }

  // ---- Gatekeeping UI ----
  if (loading) return <div className="p-4 text-white/80">Checking access…</div>;
  if (!isAdmin) return <div className="p-4 text-rose-400">Access denied</div>;

  return (
    <div className="space-y-4 p-4 text-white">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin Console</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={fetching}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
          >
            {fetching ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={saveAll}
            disabled={saving}
            className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
          >
            {saving ? "Saving…" : "Save all"}
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {err}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left text-white/70">User</th>
              <th className="px-3 py-2 text-left text-white/70">Email</th>
              <th className="px-3 py-2 text-left text-white/70">Seats</th>
              <th className="px-3 py-2 text-left text-white/70">Balance ($)</th>
              <th className="px-3 py-2 text-left text-white/70">Templates Locked</th>
              <th className="px-3 py-2 text-left text-white/70">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const usd = centsToUsd(r.balance_cents);
              return (
                <tr key={r.id} className="border-t border-white/10">
                  <td className="px-3 py-2">{r.full_name || "—"}</td>
                  <td className="px-3 py-2 text-white/80">{r.email || "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      value={r.seats ?? 0}
                      onChange={(e) => patchRow(r.id, { seats: Number(e.target.value) })}
                      className="w-24 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/40"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-white/60">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={usd}
                        onChange={(e) =>
                          patchRow(r.id, { balance_cents: usdToCents(e.target.value) })
                        }
                        className="w-28 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/40"
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!r.templates_locked}
                        onChange={(e) => patchRow(r.id, { templates_locked: e.target.checked })}
                      />
                      <span className="text-white/80">Locked</span>
                    </label>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => saveRow(r)}
                      className="rounded-md border border-white/20 px-3 py-1 hover:bg-white/10"
                    >
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && !fetching && (
              <tr>
                <td className="px-3 py-6 text-center text-white/60" colSpan={6}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/50">
        Tip: “Templates Locked” can be used to disable a user’s templates while you’re pushing updates.
      </p>
    </div>
  );
}
AdminConsole.jsx
