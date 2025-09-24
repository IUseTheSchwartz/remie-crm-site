// File: src/pages/AdminConsole.jsx
import { useEffect, useMemo, useState } from "react";
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

  // --- Load & merge across tables ---
  async function load() {
    setFetching(true);
    setErr("");

    try {
      // 1) Base list of users
      const { data: profiles, error: pErr } = await supabase
        .from("agent_profiles")
        .select("user_id, email, full_name, created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (pErr) throw pErr;

      // 2) Map owner -> team
      //    (If you have many teams not owned by users you care about, you can filter by owner_id IN (...users))
      const { data: teams, error: tErr } = await supabase
        .from("teams")
        .select("id, owner_id");
      if (tErr) throw tErr;
      const ownerToTeam = new Map();
      (teams || []).forEach((t) => {
        if (t?.owner_id && t?.id && !ownerToTeam.has(t.owner_id)) {
          ownerToTeam.set(t.owner_id, t.id);
        }
      });

      // 3) Seats for each team
      const { data: seatRows, error: sErr } = await supabase
        .from("team_seat_counts")
        .select("team_id, seats"); // <-- if your column is seat_count, change to 'seat_count'
      if (sErr) throw sErr;
      const teamSeats = new Map();
      (seatRows || []).forEach((r) => {
        if (!r) return;
        // If your column is seat_count, change r.seats -> r.seat_count
        teamSeats.set(r.team_id, Number(r.seats ?? 0));
      });

      // 4) Wallet balances
      const { data: wallets, error: wErr } = await supabase
        .from("user_wallets")
        .select("user_id, balance_cents");
      if (wErr) throw wErr;
      const walletByUser = new Map();
      (wallets || []).forEach((w) => {
        walletByUser.set(w.user_id, Number(w.balance_cents ?? 0));
      });

      // 5) Templates enabled flags (aggregate per user)
      //    We'll fetch user_id+enabled, then compute enabled_count by user.
      const { data: tmpl, error: mtErr } = await supabase
        .from("message_templates")
        .select("user_id, enabled");
      if (mtErr) throw mtErr;

      const enabledCountByUser = new Map();
      (tmpl || []).forEach((m) => {
        const uid = m.user_id;
        if (!uid) return;
        const cur = enabledCountByUser.get(uid) || 0;
        enabledCountByUser.set(uid, cur + (m.enabled ? 1 : 0));
      });

      // Merge all into a unified row per user
      const merged = (profiles || []).map((p) => {
        const teamId = ownerToTeam.get(p.user_id) || null;
        const seats = teamId ? (teamSeats.get(teamId) ?? 0) : 0;
        const balance_cents = walletByUser.get(p.user_id) ?? 0;
        const enabledCount = enabledCountByUser.get(p.user_id) ?? 0;
        // locked = NO templates enabled
        const templates_locked = enabledCount === 0;

        return {
          id: p.user_id, // stable key we use for updates
          full_name: p.full_name || "",
          email: p.email || "",
          team_id: teamId,
          seats,
          balance_cents,
          templates_locked,
          created_at: p.created_at,
        };
      });

      setRows(merged);
    } catch (e) {
      setErr(e.message || "Failed to load admin data");
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // --- Persist a single row back to the right tables ---
  async function saveRow(row) {
    setSaving(true);
    setErr("");
    try {
      // 1) Seats -> team_seat_counts (requires team_id)
      if (row.team_id != null) {
        const { error: seatsErr } = await supabase
          .from("team_seat_counts")
          .update({ seats: Number(row.seats) || 0 }) // <-- if your column is seat_count, change to { seat_count: ... }
          .eq("team_id", row.team_id);
        if (seatsErr) throw seatsErr;
      }

      // 2) Balance -> user_wallets
      {
        const { error: wErr } = await supabase
          .from("user_wallets")
          .update({ balance_cents: Number(row.balance_cents) || 0 })
          .eq("user_id", row.id);
        if (wErr) throw wErr;
      }

      // 3) Templates lock -> message_templates (bulk)
      //    locked=true  => set enabled=false for all that user
      //    locked=false => set enabled=true  for all that user
      {
        const setEnabled = !row.templates_locked;
        const { error: mtErr } = await supabase
          .from("message_templates")
          .update({ enabled: setEnabled })
          .eq("user_id", row.id);
        if (mtErr) throw mtErr;
      }
    } catch (e) {
      setErr(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // --- Optional: bulk save all visible rows ---
  async function saveAll() {
    setSaving(true);
    setErr("");
    try {
      // Do each write type in small batches. This keeps it simple and explicit.
      const batched = [...rows];

      // a) seats (only where team_id exists)
      const seatsUpdates = batched
        .filter((r) => r.team_id != null)
        .map((r) => ({
          team_id: r.team_id,
          seats: Number(r.seats) || 0, // or seat_count
        }));
      if (seatsUpdates.length) {
        // No upsert because we only want to update existing rows by team_id.
        // Run updates one by one to keep it safe (simplest).
        for (const u of seatsUpdates) {
          const { error } = await supabase
            .from("team_seat_counts")
            .update({ seats: u.seats })
            .eq("team_id", u.team_id);
          if (error) throw error;
        }
      }

      // b) wallet balances
      const walletUpdates = batched.map((r) => ({
        user_id: r.id,
        balance_cents: Number(r.balance_cents) || 0,
      }));
      for (const u of walletUpdates) {
        const { error } = await supabase
          .from("user_wallets")
          .update({ balance_cents: u.balance_cents })
          .eq("user_id", u.user_id);
        if (error) throw error;
      }

      // c) templates lock
      for (const r of batched) {
        const setEnabled = !r.templates_locked;
        const { error } = await supabase
          .from("message_templates")
          .update({ enabled: setEnabled })
          .eq("user_id", r.id);
        if (error) throw error;
      }
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
        Locked = all templates disabled (we set <code>enabled=false</code> on every template for that user).
      </p>
    </div>
  );
}
