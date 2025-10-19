// File: src/pages/AdminConsole.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import useIsAdminAllowlist from "../hooks/useIsAdminAllowlist.js";

// ✅ Toll-Free Number pool admin section (kept)
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
const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY"
];
const STATE_NAME_BY_CODE = Object.fromEntries(
  [
    ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
    ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],
    ["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
    ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],
    ["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],
    ["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
    ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
    ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],
    ["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],
    ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"]
  ]
);

/* ---------------------------- page ----------------------------- */
export default function AdminConsole() {
  const { isAdmin, loading } = useIsAdminAllowlist();

  const [rows, setRows] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // --- NEW: Global credit UI state ---
  const [creditUsd, setCreditUsd] = useState("0.10");
  const [creditNote, setCreditNote] = useState("Thanks for being with Remie CRM!");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditResult, setCreditResult] = useState(null);

  /* --------------------------- loader --------------------------- */
  async function load() {
    setFetching(true);
    setErr("");

    try {
      // 1) base: agent profiles (users list)
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

      // 3) seats per team (view)
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

      // 7) Lead Rescue flags
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
        const seatsPurchased = teamId ? (teamSeats.get(teamId) ?? 0) : 0;
        const balance = walletByUser.get(p.user_id) ?? 0;

        const t = tmplByUser.get(p.user_id) || { enabled: {}, templates: {} };
        const enabled_backup = backupByUser.get(p.user_id) || null;

        const keyUniverse = allKeysFrom(t.enabled, t.templates);
        const allOff =
          keyUniverse.length > 0
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
          _enabled: t.enabled || {},
          _templates: t.templates || {},
          _enabled_backup: enabled_backup,
        };
      });

      setRows(merged);
    } catch (e) {
      setErr(e.message || "Failed to load admin data");
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  /* -------------------------- mutations ------------------------- */
  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveRow(row) {
    setSaving(true);
    setErr("");
    try {
      // 0) Lead Rescue
      {
        const { error } = await supabase
          .from("lead_rescue_settings")
          .upsert([{ user_id: row.id, enabled: !!row.lead_rescue_enabled }], { onConflict: "user_id" });
        if (error) throw error;
      }

      // 1) Seats via RPC
      if (row.team_id != null) {
        const { error: seatsErr } = await supabase.rpc("admin_set_team_seats", {
          p_team_id: row.team_id,
          p_seats_purchased: Number(row.seats_purchased) || 0,
        });
        if (seatsErr) throw seatsErr;
      }

      // 2) Balance
      {
        const { error: wErr } = await supabase
          .from("user_wallets")
          .upsert([{ user_id: row.id, balance_cents: Number(row.balance_cents) || 0 }], {
            onConflict: "user_id",
          });
        if (wErr) throw wErr;
      }

      // 3) Templates lock/unlock
      {
        const enabled = row._enabled || {};
        const templates = row._templates || {};
        const enabled_backup = row._enabled_backup || null;

        if (row.templates_locked) {
          const nextBackup = enabled_backup ?? enabled;
          const nextEnabled = makeAll(enabled, templates, false);

          const { error } = await supabase
            .from("message_templates")
            .upsert([{ user_id: row.id, enabled: nextEnabled }], { onConflict: "user_id" });
          if (error) throw error;

          const { error: bErr } = await supabase
            .from("message_templates_backup")
            .upsert([{ user_id: row.id, enabled_backup: nextBackup }], { onConflict: "user_id" });
          if (bErr) throw bErr;

          row._enabled = nextEnabled;
          row._enabled_backup = nextBackup;
        } else {
          const nextEnabled = enabled_backup ? enabled_backup : makeAll(enabled, templates, true);

          const { error } = await supabase
            .from("message_templates")
            .upsert([{ user_id: row.id, enabled: nextEnabled }], { onConflict: "user_id" });
          if (error) throw error;

          if (enabled_backup) {
            const { error: dErr } = await supabase
              .from("message_templates_backup")
              .delete()
              .eq("user_id", row.id);
            if (dErr) throw dErr;
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

      // a) lead rescue flags
      for (const r of batched) {
        const { error } = await supabase
          .from("lead_rescue_settings")
          .upsert([{ user_id: r.id, enabled: !!r.lead_rescue_enabled }], { onConflict: "user_id" });
        if (error) throw error;
      }

      // b) seats via RPC
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

      // d) templates lock/unlock
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

  // --- NEW: call the Netlify function to credit everyone ---
  async function creditEveryoneNow() {
    setCreditBusy(true);
    setErr("");
    setCreditResult(null);
    try {
      const amount_cents = usdToCents(creditUsd);
      if (!(amount_cents > 0)) throw new Error("Enter a positive amount");

      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/.netlify/functions/admin-credit-everyone", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ amount_cents, message: creditNote }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Request failed (${res.status})`);

      setCreditResult({ credited: json.credited, amount_cents: json.amount_cents });
      await load();
    } catch (e) {
      setErr(e.message || "Failed to credit everyone");
    } finally {
      setCreditBusy(false);
    }
  }

  /* ===================== Agent Site Onboarding (NEW) ===================== */

  // Manual user override: paste Supabase UUID to onboard anyone (brand-new OK)
  const [manualUserId, setManualUserId] = useState("");
  const [selUserId, setSelUserId] = useState(""); // current user being edited
  const [apLoading, setApLoading] = useState(false);
  const [apSaving, setApSaving] = useState(false);
  const [statesSaving, setStatesSaving] = useState(false);

  // agent_profiles fields
  const [ap, setAp] = useState({
    full_name: "",
    email: "",
    phone: "",
    short_bio: "",
    npn: "",
    calendly_url: "",
    headshot_url: "",
    slug: "",
    published: false,
  });

  // simple slug
  const slug = useMemo(
    () =>
      (ap.full_name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)+/g, "") || "my-profile",
    [ap.full_name]
  );

  // agent_states rows (array of {state_code, license_number, license_image_url})
  const [stateRows, setStateRows] = useState([]);

  function addStateRow() {
    setStateRows((s) => [...s, { state_code: "", license_number: "", license_image_url: "" }]);
  }
  function patchStateRow(idx, patch) {
    setStateRows((s) => s.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeStateRow(idx) {
    setStateRows((s) => s.filter((_, i) => i !== idx));
  }

  async function useManualUserId() {
    const id = manualUserId.trim();
    if (!id) return;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      alert("That doesn't look like a UUID.");
      return;
    }
    setSelUserId(id);
    setManualUserId("");
    await loadAgentFor(id);
  }

  async function loadAgentFor(userId) {
    setApLoading(true);
    setErr("");
    try {
      // Try fetch existing profile
      const { data: prof, error: pErr } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (pErr) throw pErr;

      // If no profile, try to pull email from auth via edge function OR let admin type it
      const emailGuess = prof?.email || "";

      setAp({
        full_name: prof?.full_name || "",
        email: emailGuess,
        phone: prof?.phone || "",
        short_bio: prof?.short_bio || "",
        npn: prof?.npn || "",
        calendly_url: prof?.calendly_url || "",
        headshot_url: prof?.headshot_url || "",
        slug: prof?.slug || "",
        published: !!prof?.published,
      });

      // Load states
      const { data: st, error: sErr } = await supabase
        .from("agent_states")
        .select("state_code, license_number, license_image_url")
        .eq("user_id", userId);
      if (sErr) throw sErr;

      setStateRows(
        (st || []).map((r) => ({
          state_code: r.state_code,
          license_number: r.license_number || "",
          license_image_url: r.license_image_url || "",
        }))
      );
    } catch (e) {
      setErr(e.message || "Failed to load agent profile");
      setAp({
        full_name: "",
        email: "",
        phone: "",
        short_bio: "",
        npn: "",
        calendly_url: "",
        headshot_url: "",
        slug: "",
        published: false,
      });
      setStateRows([]);
    } finally {
      setApLoading(false);
    }
  }

  async function saveAgentProfile() {
    if (!selUserId) {
      alert("Choose or paste a user_id first.");
      return;
    }
    setApSaving(true);
    setErr("");
    try {
      const payload = {
        user_id: selUserId,
        slug,
        full_name: ap.full_name || null,
        email: ap.email || null,
        phone: ap.phone || null,
        short_bio: ap.short_bio || null,
        npn: ap.npn || null,
        calendly_url: ap.calendly_url || null,
        headshot_url: ap.headshot_url || null,
        published: !!ap.published,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("agent_profiles")
        .upsert(payload, { onConflict: "user_id" });
      if (error) throw error;

      alert("Agent profile saved.");
    } catch (e) {
      setErr(e.message || "Failed to save agent profile");
    } finally {
      setApSaving(false);
    }
  }

  async function saveAgentStates() {
    if (!selUserId) {
      alert("Choose or paste a user_id first.");
      return;
    }
    setStatesSaving(true);
    setErr("");
    try {
      // Validate rows
      const cleaned = stateRows
        .map((r) => ({
          state_code: (r.state_code || "").toUpperCase().trim(),
          license_number: (r.license_number || "").trim(),
          license_image_url: (r.license_image_url || "").trim(),
        }))
        .filter((r) => r.state_code);

      for (const r of cleaned) {
        if (!STATES.includes(r.state_code)) {
          throw new Error(`Invalid state code: ${r.state_code}`);
        }
        if (!r.license_number) {
          throw new Error(`Missing license number for ${r.state_code}`);
        }
        if (!r.license_image_url) {
          throw new Error(`Missing license image/PDF URL for ${r.state_code}`);
        }
      }

      // Fetch existing for diff
      const { data: existing, error: selErr } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", selUserId);
      if (selErr) throw selErr;
      const existingSet = new Set((existing || []).map((x) => x.state_code));

      const desiredSet = new Set(cleaned.map((x) => x.state_code));
      const toDelete = [...existingSet].filter((c) => !desiredSet.has(c));

      // Upsert
      if (cleaned.length) {
        const upPayload = cleaned.map((r) => ({
          user_id: selUserId,
          state_code: r.state_code,
          state_name: STATE_NAME_BY_CODE[r.state_code] || r.state_code,
          license_number: r.license_number,
          license_image_url: r.license_image_url,
          updated_at: new Date().toISOString(),
        }));
        const { error: upErr } = await supabase
          .from("agent_states")
          .upsert(upPayload, { onConflict: "user_id,state_code" });
        if (upErr) throw upErr;
      }

      // Delete removed
      if (toDelete.length) {
        const { error: delErr } = await supabase
          .from("agent_states")
          .delete()
          .eq("user_id", selUserId)
          .in("state_code", toDelete);
        if (delErr) throw delErr;
      }

      alert("Agent states saved.");
    } catch (e) {
      setErr(e.message || "Failed to save agent states");
    } finally {
      setStatesSaving(false);
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

      {/* ---------- Global Wallet Credit ---------- */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
        <div className="font-medium mb-2">Global actions</div>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_auto] items-center">
          <label className="text-sm text-white/70">Amount (USD)</label>
          <input
            type="text"
            inputMode="decimal"
            value={creditUsd}
            onChange={(e) => setCreditUsd(e.target.value)}
            className="rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/40 w-40"
            placeholder="0.10"
          />
          <button
            onClick={creditEveryoneNow}
            disabled={creditBusy}
            className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
          >
            {creditBusy ? "Crediting…" : "Credit everyone"}
          </button>

          <label className="text-sm text-white/70 sm:col-start-1">Message (optional)</label>
          <input
            type="text"
            value={creditNote}
            onChange={(e) => setCreditNote(e.target.value)}
            className="rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/40 sm:col-span-2"
            placeholder="Shown in admin logs; users will see new balance next load."
          />
        </div>

        {creditResult && (
          <div className="mt-3 text-sm text-emerald-300">
            Credited {creditResult.credited} users with ${centsToUsd(creditResult.amount_cents)} each.
          </div>
        )}
        <p className="mt-2 text-xs text-white/45">
          Adds the amount to <code>user_wallets.balance_cents</code> for all users.
        </p>
      </div>

      {/* ---------- Users table ---------- */}
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
                        onChange={(e) => patchRow(r.id, { balance_cents: usdToCents(e.target.value) })}
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

      {/* ---------- TFN Pool Admin Section ---------- */}
      <div className="pt-6 border-t border-white/10">
        <TFNPoolAdminSection />
      </div>

      {/* ================= Agent Site Onboarding (NEW) ================= */}
      <div className="pt-6 border-t border-white/10">
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-medium">Agent Site Onboarding</div>
            <div className="flex items-center gap-2">
              <input
                className="w-[280px] rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-indigo-500/40"
                placeholder="Paste Supabase user_id (UUID)…"
                value={manualUserId}
                onChange={(e) => setManualUserId(e.target.value)}
              />
              <button
                onClick={useManualUserId}
                className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
              >
                Use ID
              </button>
            </div>
          </div>

          {!selUserId ? (
            <div className="text-white/60 text-sm">
              Paste a user’s UUID from Supabase Auth to start onboarding. You can set up a completely new account this way.
            </div>
          ) : (
            <>
              <div className="text-xs text-white/60 mb-2">Editing user_id: <span className="font-mono">{selUserId}</span></div>

              {/* Profile form */}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">Full name</div>
                  <input
                    value={ap.full_name}
                    onChange={(e) => setAp((v) => ({ ...v, full_name: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="First Last"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">Email</div>
                  <input
                    value={ap.email}
                    onChange={(e) => setAp((v) => ({ ...v, email: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="name@email.com"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">Phone</div>
                  <input
                    value={ap.phone}
                    onChange={(e) => setAp((v) => ({ ...v, phone: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="(555) 555-5555"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">NPN</div>
                  <input
                    value={ap.npn}
                    onChange={(e) => setAp((v) => ({ ...v, npn: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="National Producer Number"
                  />
                </label>
                <label className="block md:col-span-2">
                  <div className="mb-1 text-xs text-white/70">Calendly (optional)</div>
                  <input
                    value={ap.calendly_url}
                    onChange={(e) => setAp((v) => ({ ...v, calendly_url: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="https://calendly.com/your-name/meeting"
                  />
                </label>
                <label className="block md:col-span-2">
                  <div className="mb-1 text-xs text-white/70">Short bio</div>
                  <textarea
                    value={ap.short_bio}
                    onChange={(e) => setAp((v) => ({ ...v, short_bio: e.target.value }))}
                    className="w-full min-h-[90px] rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="One–two sentences…"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">Headshot URL (optional)</div>
                  <input
                    value={ap.headshot_url}
                    onChange={(e) => setAp((v) => ({ ...v, headshot_url: e.target.value }))}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 outline-none"
                    placeholder="https://…"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-white/70">Slug (auto)</div>
                  <input
                    value={slug}
                    disabled
                    className="w-full rounded-md border border-white/15 bg-black/20 px-3 py-2 outline-none"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!ap.published}
                    onChange={(e) => setAp((v) => ({ ...v, published: e.target.checked }))}
                  />
                  <span className="text-sm">Publish</span>
                </label>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  onClick={() => loadAgentFor(selUserId)}
                  disabled={apLoading}
                  className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
                >
                  {apLoading ? "Reloading…" : "Reload"}
                </button>
                <button
                  onClick={saveAgentProfile}
                  disabled={apSaving}
                  className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
                >
                  {apSaving ? "Saving…" : "Save Profile"}
                </button>
              </div>

              {/* States editor */}
              <div className="mt-6">
                <div className="mb-2 text-sm font-medium">Licensed States</div>
                <div className="space-y-2">
                  {stateRows.map((row, idx) => (
                    <div
                      key={idx}
                      className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-4"
                    >
                      <div>
                        <div className="mb-1 text-xs text-white/70">State</div>
                        <select
                          value={row.state_code}
                          onChange={(e) => patchStateRow(idx, { state_code: e.target.value })}
                          className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                        >
                          <option value="">Select…</option>
                          {STATES.map((c) => (
                            <option key={c} value={c}>
                              {c} — {STATE_NAME_BY_CODE[c]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div className="mb-1 text-xs text-white/70">License #</div>
                        <input
                          value={row.license_number}
                          onChange={(e) => patchStateRow(idx, { license_number: e.target.value })}
                          className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <div className="mb-1 text-xs text-white/70">License Image/PDF URL</div>
                        <input
                          value={row.license_image_url}
                          onChange={(e) => patchStateRow(idx, { license_image_url: e.target.value })}
                          className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 outline-none"
                          placeholder="https://…"
                        />
                      </div>
                      <div className="md:col-span-4 flex items-center justify-end">
                        <button
                          type="button"
                          onClick={() => removeStateRow(idx)}
                          className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addStateRow}
                    className="rounded-md border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
                  >
                    + Add state
                  </button>
                  <button
                    type="button"
                    onClick={saveAgentStates}
                    disabled={statesSaving}
                    className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
                  >
                    {statesSaving ? "Saving…" : "Save States"}
                  </button>
                </div>
              </div>

              {/* Public URL preview */}
              <div className="mt-4 text-xs text-white/60">
                Public page:&nbsp;
                <a
                  href={`${window.location.origin}/a/${slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-300 underline"
                >
                  {`${window.location.origin}/a/${slug}`}
                </a>
              </div>
            </>
          )}
        </div>
      </div>

      {/* NOTE: Partners section removed on purpose */}
    </div>
  );
}
