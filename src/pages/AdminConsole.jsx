// File: src/pages/AdminConsole.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import useIsAdminAllowlist from "../hooks/useIsAdminAllowlist.js";

// ✅ Partners admin section
import PartnersAdminSection from "../components/admin/PartnersAdminSection.jsx";

// ✅ NEW: Toll-Free Number pool admin section
import TFNPoolAdminSection from "../components/admin/TFNPoolAdminSection.jsx";

/* ------------------------ small helpers ------------------------ */
function centsToUsd(cents) {
  if (cents == null || Number.isNaN(cents)) return "0.00";
  return (Number(cents) / 100).toFixed(2);
}
function usdToCents(usdStr) {
  const n = Number(String(usdStr).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}
function allKeysFrom(enabledObj = {}, templatesObj = {}) {
  const keys = new Set([...Object.keys(enabledObj || {}), ...Object.keys(templatesObj || {})]);
  return [...keys];
}
function makeAll(enabledObj, templatesObj, val) {
  const out = {};
  for (const k of allKeysFrom(enabledObj, templatesObj)) out[k] = Boolean(val);
  return out;
}

/* ---------------------------- page ----------------------------- */
export default function AdminConsole() {
  const { isAdmin, loading } = useIsAdminAllowlist();
  const [rows, setRows] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  /* --------------------------- loader --------------------------- */
  async function load() {
    setFetching(true);
    setErr("");

    try {
      // 1) base: agent profiles
      const { data: profiles, error: pErr } = await supabase
        .from("agent_profiles")
        .select("user_id, email, full_name, created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (pErr) throw pErr;

      // 2) owner → team
      const { data: teams, error: tErr } = await supabase
        .from("teams")
        .select("id, owner_id");
      if (tErr) throw tErr;
      const ownerToTeam = new Map();
      (teams || []).forEach((t) => {
        if (t?.owner_id && t?.id && !ownerToTeam.has(t.owner_id)) ownerToTeam.set(t.owner_id, t.id);
      });

      // 3) seats per team (read from the view)
      const { data: seatRows, error: sErr } = await supabase
        .from("team_seat_counts")
        .select("team_id, seats_purchased");
      if (sErr) throw sErr;
      const teamSeats = new Map();
      (seatRows || []).forEach((r) => {
        if (!r) return;
        teamSeats.set(r.team_id, Number(r.seats_purchased ?? 0));
      });

      // 4) wallet balances
      const { data: wallets, error: wErr } = await supabase
        .from("user_wallets")
        .select("user_id, balance_cents");
      if (wErr) throw wErr;
      const walletByUser = new Map();
      (wallets || []).forEach((w) => {
        walletByUser.set(w.user_id, Number(w.balance_cents ?? 0));
      });

      // 5) message templates (enabled map & templates)
      const { data: tmpl, error: mtErr } = await supabase
        .from("message_templates")
        .select("user_id, enabled, templates");
      if (mtErr) throw mtErr;
      const tmplByUser = new Map();
      (tmpl || []).forEach((m) => {
        tmplByUser.set(m.user_id, {
          enabled: m.enabled || {},
          templates: m.templates || {},
        });
      });

      // 6) backup table (previous enabled)
      const { data: backups, error: bErr } = await supabase
        .from("message_templates_backup")
        .select("user_id, enabled_backup");
      if (bErr) throw bErr;
      const backupByUser = new Map();
      (backups || []).forEach((b) => {
        backupByUser.set(b.user_id, b.enabled_backup || null);
      });

      // 7) Lead Rescue flags (source of truth)
      const { data: lr, error: lrErr } = await supabase
        .from("lead_rescue_settings")
        .select("user_id, enabled");
      if (lrErr) throw lrErr;
      const leadRescueByUser = new Map();
      (lr || []).forEach((r) => {
        leadRescueByUser.set(r.user_id, Boolean(r.enabled));
      });

      // Merge into rows
      const merged = (profiles || []).map((p) => {
        const teamId = ownerToTeam.get(p.user_id) || null;
        const seatsPurchased = teamId ? (teamSeats.get(teamId) ?? 0) : 0; // ✅ fixed
        const balance = walletByUser.get(p.user_id) ?? 0;

        const t = tmplByUser.get(p.user_id) || { enabled: {}, templates: {} };
        const enabled_backup = backupByUser.get(p.user_id) || null;

        const keyUniverse = allKeysFrom(t.enabled, t.templates);
        const allOff = keyUniverse.length > 0
          ? keyUniverse.every((k) => Boolean(t.enabled?.[k]) === false)
          : true; // treat empty as locked
        const templates_locked = allOff;

        const lead_rescue_enabled = leadRescueByUser.has(p.user_id)
          ? leadRescueByUser.get(p.user_id)
          : true; // default ON if no row yet

        return {
          id: p.user_id,
          full_name: p.full_name || "",
          email: p.email || "",
          team_id: teamId,
          seats_purchased: seatsPurchased,
          balance_cents: balance,
          lead_rescue_enabled,
          templates_locked,
          created_at: p.created_at,
          // raw blobs for lock/unlock logic
          _enabled: t.enabled || {},
          _templates: t.templates || {},
          _enabled_backup: enabled_backup, // from backup table
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

  /* -------------------------- mutations ------------------------- */
  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveRow(row) {
    setSaving(true);
    setErr("");
       try {
      // 0) Lead Rescue enable/disable -> upsert into lead_rescue_settings
      {
        const { error } = await supabase
          .from("lead_rescue_settings")
          .upsert(
            [{ user_id: row.id, enabled: !!row.lead_rescue_enabled }],
            { onConflict: "user_id" }
          );
        if (error) throw error;
      }

      // 1) Seats -> call RPC (works even if team_seat_counts is a view)
      if (row.team_id != null) {
        const { error: seatsErr } = await supabase.rpc("admin_set_team_seats", {
          p_team_id: row.team_id,
          p_seats_purchased: Number(row.seats_purchased) || 0,
        });
        if (seatsErr) throw seatsErr;
      }

      // 2) Balance -> user_wallets (upsert by user_id)
      {
        const { error: wErr } = await supabase
          .from("user_wallets")
          .upsert(
            [{ user_id: row.id, balance_cents: Number(row.balance_cents) || 0 }],
            { onConflict: "user_id" }
          );
        if (wErr) throw wErr;
      }

      // 3) Templates lock/unlock using backup table
      {
        const enabled = row._enabled || {};
        const templates = row._templates || {};
        const enabled_backup = row._enabled_backup || null;

        if (row.templates_locked) {
          // LOCK -> save backup (first time) and set all false
          const nextBackup = enabled_backup ?? enabled;
          const nextEnabled = makeAll(enabled, templates, false);

          // upsert main
          {
            const { error } = await supabase
              .from("message_templates")
              .upsert([{ user_id: row.id, enabled: nextEnabled }], { onConflict: "user_id" });
            if (error) throw error;
          }
          // upsert backup
          {
            const { error } = await supabase
              .from("message_templates_backup")
              .upsert(
                [{ user_id: row.id, enabled_backup: nextBackup }],
                { onConflict: "user_id" }
              );
            if (error) throw error;
          }

          row._enabled = nextEnabled;
          row._enabled_backup = nextBackup;
        } else {
          // UNLOCK -> restore backup or enable all
          const nextEnabled = enabled_backup ? enabled_backup : makeAll(enabled, templates, true);

          // upsert main
          {
            const { error } = await supabase
              .from("message_templates")
              .upsert([{ user_id: row.id, enabled: nextEnabled }], { onConflict: "user_id" });
            if (error) throw error;
          }
          // clear backup if it existed
          if (enabled_backup) {
            const { error } = await supabase
              .from("message_templates_backup")
              .delete()
              .eq("user_id", row.id);
            if (error) throw error;
          }

          row._enabled = nextEnabled;
          row._enabled_backup = null;
        }
      }
    } catch (e) {
      setErr(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    setSaving(true);
    setErr("");
    try {
      const batched = [...rows];

      // a) lead rescue flags (upsert)
      for (const r of batched) {
        const { error } = await supabase
          .from("lead_rescue_settings")
          .upsert(
            [{ user_id: r.id, enabled: !!r.lead_rescue_enabled }],
            { onConflict: "user_id" }
          );
        if (error) throw error;
      }

      // b) seats via RPC (per row; view-safe)
      for (const r of batched) {
        if (r.team_id == null) continue;
        const { error } = await supabase.rpc("admin_set_team_seats", {
          p_team_id: r.team_id,
          p_seats_purchased: Number(r.seats_purchased) || 0,
        });
        if (error) throw error;
      }

      // c) wallet upserts
      const walletPayload = batched.map((r) => ({
        user_id: r.id,
        balance_cents: Number(r.balance_cents) || 0,
      }));
      if (walletPayload.length) {
        const { error } = await supabase
          .from("user_wallets")
          .upsert(walletPayload, { onConflict: "user_id" });
        if (error) throw error;
      }

      // d) templates lock/unlock respecting backup
      for (const r of batched) {
        const enabled = r._enabled || {};
        const templates = r._templates || {};
        const enabled_backup = r._enabled_backup || null;

        if (r.templates_locked) {
          const nextBackup = enabled_backup ?? enabled;
          const nextEnabled = makeAll(enabled, templates, false);

          const { error: e1 } = await supabase
            .from("message_templates")
            .upsert([{ user_id: r.id, enabled: nextEnabled }], { onConflict: "user_id" });
          if (e1) throw e1;

          const { error: e2 } = await supabase
            .from("message_templates_backup")
            .upsert([{ user_id: r.id, enabled_backup: nextBackup }], { onConflict: "user_id" });
          if (e2) throw e2;

          r._enabled = nextEnabled;
          r._enabled_backup = nextBackup;
        } else {
          const nextEnabled = enabled_backup ? enabled_backup : makeAll(enabled, templates, true);

          const { error: e1 } = await supabase
            .from("message_templates")
            .upsert([{ user_id: r.id, enabled: nextEnabled }], { onConflict: "user_id" });
          if (e1) throw e1;

          if (enabled_backup) {
            const { error: e2 } = await supabase
              .from("message_templates_backup")
              .delete()
              .eq("user_id", r.id);
            if (e2) throw e2;
          }

          r._enabled = nextEnabled;
          r._enabled_backup = null;
        }
      }
    } catch (e) {
      setErr(e.message || "Failed to save all");
    } finally {
      setSaving(false);
    }
  }

  /* -------------------------- rendering ------------------------- */
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
              <th className="px-3 py-2 text-left text-white/70">Team ID</th>
              <th className="px-3 py-2 text-left text-white/70">Seats Purchased</th>
              <th className="px-3 py-2 text-left text-white/70">Balance ($)</th>
              <th className="px-3 py-2 text-left text-white/70">Lead Rescue</th>
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
                  <td className="px-3 py-2 text-white/60 text-[11px]">{r.team_id || "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      value={r.seats_purchased ?? 0}
                      disabled={!r.team_id}
                      onChange={(e) => patchRow(r.id, { seats_purchased: Number(e.target.value) })}
                      className="w-24 rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
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
                        checked={!!r.lead_rescue_enabled}
                        onChange={(e) => patchRow(r.id, { lead_rescue_enabled: e.target.checked })}
                      />
                      <span className="text-white/80">Enabled</span>
                    </label>
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
                <td className="px-3 py-6 text-center text-white/60" colSpan={8}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/50">
        Lead Rescue toggle is stored in <code>lead_rescue_settings.enabled</code> (upserted on save).
        Locked = all templates disabled. We keep the prior state in{" "}
        <code>message_templates_backup</code> so unlocking restores exactly what they had.
      </p>

      {/* ---------- NEW: TFN Pool Admin Section ---------- */}
      <div className="pt-6 border-t border-white/10">
        <TFNPoolAdminSection />
      </div>

      {/* ---------- NEW: Partners Admin Section ---------- */}
      <div className="pt-6 border-t border-white/10">
        <PartnersAdminSection />
      </div>
    </div>
  );
}
