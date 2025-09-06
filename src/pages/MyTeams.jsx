// File: src/pages/MyTeams.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

const ACTIVE_STATES = ["active", "trialing", "past_due"]; // treat past_due as a grace period

export default function MyTeams() {
  const [loading, setLoading] = useState(true);
  const [subCheck, setSubCheck] = useState({ eligible: false, reason: "checking…" });
  const [teams, setTeams] = useState([]);
  const [creating, setCreating] = useState(false);

  async function checkSubscriptionEligibility() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      setSubCheck({ eligible: false, reason: "not signed in" });
      return;
    }

    // 1) try Stripe-style table: subscriptions (single latest row)
    let eligible = false;
    let reason = "no subscription found";

    // helper: normalize status
    const isEligible = (status) => ACTIVE_STATES.includes((status || "").toLowerCase());

    // Try common table names/columns, safely
    try {
      const { data: subRow, error: subErr } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!subErr && subRow?.status) {
        eligible = isEligible(subRow.status);
        reason = eligible ? "subscriptions.status=" + subRow.status : "subscriptions.status=" + subRow.status;
      }
    } catch (_) {
      // ignore
    }

    // 2) fallback: profiles table fields (plan_status or subscription_status or plan_expires_at)
    if (!eligible) {
      try {
        const { data: profileRow } = await supabase
          .from("profiles")
          .select("plan_status, subscription_status, plan_expires_at")
          .eq("id", uid)
          .maybeSingle();

        const p = profileRow || {};
        const byStatus =
          isEligible(p.plan_status) || isEligible(p.subscription_status);

        // consider plan_expires_at as active if in the future
        const byExpiry =
          p.plan_expires_at ? new Date(p.plan_expires_at).getTime() > Date.now() : false;

        if (byStatus || byExpiry) {
          eligible = true;
          reason = byStatus
            ? `profiles.status=${(p.plan_status || p.subscription_status || "").toString()}`
            : "profiles.plan_expires_at in future";
        } else if (p.plan_status || p.subscription_status || p.plan_expires_at) {
          reason = `profiles indicates inactive`;
        }
      } catch (_) {
        // ignore
      }
    }

    setSubCheck({ eligible, reason });
  }

  async function loadTeams() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;

    const { data } = await supabase
      .from("user_teams")
      .select("team_id, role, status, teams(name)")
      .eq("user_id", uid)
      .order("created_at", { ascending: false });

    setTeams(data || []);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([checkSubscriptionEligibility(), loadTeams()]);
      setLoading(false);
    })();
  }, []);

  async function handleCreateTeam() {
    if (!subCheck.eligible || creating) return;

    setCreating(true);
    try {
      // Create a team row; adjust table/columns to your schema
      const name = prompt("Team name?");
      if (!name) return;

      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;

      // 1) create the team
      const { data: team, error: teamErr } = await supabase
        .from("teams")
        .insert({ name })
        .select("id, name")
        .single();

      if (teamErr) throw teamErr;

      // 2) add the creator as owner in user_teams
      const { error: linkErr } = await supabase
        .from("user_teams")
        .insert({
          user_id: uid,
          team_id: team.id,
          role: "owner",
          status: "active",
        });

      if (linkErr) throw linkErr;

      await loadTeams();
      alert("Team created!");
    } catch (err) {
      console.error(err);
      alert("Failed to create team: " + (err?.message || err));
    } finally {
      setCreating(false);
    }
  }

  const canCreate = subCheck.eligible;
  const gateText = useMemo(() => {
    if (loading) return "Checking subscription…";
    if (canCreate) return "";
    return `Locked — ${subCheck.reason}`;
  }, [loading, canCreate, subCheck.reason]);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">My Teams</h1>

      {/* Create Team */}
      <div className="mb-6">
        <button
          onClick={handleCreateTeam}
          disabled={!canCreate || creating}
          className={`px-4 py-2 rounded ${
            canCreate ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-400"
          } disabled:opacity-60`}
          title={canCreate ? "Create a team" : gateText}
        >
          {creating ? "Creating…" : "Create Team"}
        </button>
        {!canCreate && (
          <div className="text-xs text-gray-400 mt-2">{gateText}</div>
        )}
      </div>

      {/* Existing teams */}
      <div className="grid gap-2">
        {teams.length === 0 ? (
          <div className="text-sm text-gray-400">You’re not in any teams yet.</div>
        ) : (
          teams.map((t) => (
            <div key={t.team_id} className="border rounded p-3">
              <div className="font-medium">{t.teams?.name || "Team"}</div>
              <div className="text-sm text-gray-400">
                Role: {t.role} • Status: {t.status}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}