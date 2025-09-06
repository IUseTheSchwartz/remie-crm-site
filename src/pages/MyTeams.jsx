// File: src/pages/MyTeams.jsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Users, Crown, LogOut, Plus, Lock } from "lucide-react";

const OK = (s) => ["active", "trialing", "past_due"].includes((s || "").toLowerCase()); // allow grace

export default function MyTeams() {
  const [me, setMe] = useState(null);
  const [owned, setOwned] = useState([]);
  const [memberOf, setMemberOf] = useState([]);
  const [loading, setLoading] = useState(true);

  // subscription sources
  const [planStatus, setPlanStatus] = useState("");              // profiles.plan_status
  const [profileSubStatus, setProfileSubStatus] = useState("");  // profiles.subscription_status (if used)
  const [planExpiresAt, setPlanExpiresAt] = useState(null);      // profiles.plan_expires_at (if used)
  const [stripeStatus, setStripeStatus] = useState("");          // subscriptions.status (Stripe)

  const [creating, setCreating] = useState(false);               // NEW: creating flag
  const nav = useNavigate();

  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await getCurrentUserId();
      setMe(uid);

      // ----- Personal plan info (from profiles)
      try {
        const { data: prof } = await supabase
          .from("profiles")
          .select("plan_status, subscription_status, plan_expires_at")
          .eq("id", uid)
          .maybeSingle();

        setPlanStatus((prof?.plan_status || "").toLowerCase());
        setProfileSubStatus((prof?.subscription_status || "").toLowerCase());
        setPlanExpiresAt(prof?.plan_expires_at || null);
      } catch {
        setPlanStatus("");
        setProfileSubStatus("");
        setPlanExpiresAt(null);
      }

      // ----- Stripe-style subscriptions table (if present)
      try {
        const { data: subRow } = await supabase
          .from("subscriptions")
          .select("status")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        setStripeStatus((subRow?.status || "").toLowerCase());
      } catch {
        setStripeStatus("");
      }

      // ----- Teams I own
      const { data: own } = await supabase
        .from("teams")
        .select("id, name, created_at")
        .eq("owner_id", uid)
        .order("created_at", { ascending: false });

      // ----- Teams I'm in (not owner)
      const { data: mem } = await supabase
        .from("user_teams")
        .select("team_id, role, status, team:teams(id, name)")
        .eq("user_id", uid)
        .neq("role", "owner")
        .eq("status", "active")
        .order("joined_at", { ascending: false });

      setOwned(own || []);
      setMemberOf((mem || []).map((m) => ({ ...m.team, role: m.role })));
      setLoading(false);
    })();
  }, []);

  async function refreshLists() {
    const uid = me;
    if (!uid) return;

    const { data: own } = await supabase
      .from("teams")
      .select("id, name, created_at")
      .eq("owner_id", uid)
      .order("created_at", { ascending: false });

    const { data: mem } = await supabase
      .from("user_teams")
      .select("team_id, role, status, team:teams(id, name)")
      .eq("user_id", uid)
      .neq("role", "owner")
      .eq("status", "active")
      .order("joined_at", { ascending: false });

    setOwned(own || []);
    setMemberOf((mem || []).map((m) => ({ ...m.team, role: m.role })));
  }

  // NEW: call your Netlify function to create the team, then navigate to Manage page
  async function handleCreateTeam() {
    const name = prompt("Team name?");
    if (!name || !name.trim()) return;

    setCreating(true);
    try {
      const res = await callFn("create-team", { name: name.trim() });
      // Accept common shapes from the function
      if (!res) throw new Error("No response from create-team.");
      if (res.error) throw new Error(res.error);
      if (res.ok === false) throw new Error(res.message || "Failed to create team.");

      const teamId =
        res.team_id || res.teamId || res.id || res.team?.id;

      if (!teamId) throw new Error("Team created but no team_id returned.");

      await refreshLists();
      nav(`/app/team/manage/${teamId}`);
    } catch (e) {
      alert(e.message || "Failed to create team.");
    } finally {
      setCreating(false);
    }
  }

  async function leave(teamId) {
    if (!confirm("Leave this team? You’ll lose access immediately.")) return;
    try {
      await callFn("leave-team", { team_id: teamId });
      await refreshLists();
    } catch (e) {
      alert(e.message || "Failed to leave team");
    }
  }

  // ✅ Unlock if ANY source indicates active/trialing (or grace) OR expiry is in the future
  const canCreateTeam =
    OK(planStatus) ||
    OK(profileSubStatus) ||
    OK(stripeStatus) ||
    (planExpiresAt && new Date(planExpiresAt).getTime() > Date.now());

  if (loading) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> My Teams
        </h1>

        {canCreateTeam ? (
          <button
            onClick={handleCreateTeam}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 hover:bg-white/5 disabled:opacity-60"
            title="Create a team"
          >
            <Plus className="w-4 h-4" /> {creating ? "Creating…" : "Create Team"}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              disabled
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-white/50 cursor-not-allowed"
              title="A personal Remie CRM subscription is required to create a team."
            >
              <Lock className="w-4 h-4" /> Create Team
            </button>
            <a
              href="https://buy.stripe.com/28E4gB8OScYeffg2qg8Ra07"
              target="_blank"
              rel="noreferrer"
              className="text-sm underline text-white/70 hover:text-white"
              title="Buy Remie CRM to create your own team"
            >
              Buy Remie CRM
            </a>
          </div>
        )}
      </header>

      {/* Teams I Own */}
      <section className="border rounded-2xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Crown className="w-4 h-4" /> Teams I Own
        </div>
        {owned.length === 0 ? (
          <div className="mt-3 text-gray-500">You don’t own any teams yet.</div>
        ) : (
          <ul className="mt-3 divide-y divide-white/10">
            {owned.map((t) => (
              <li key={t.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-gray-500">Owner</div>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/app/team/${t.id}/dashboard`}
                    className="rounded-xl border px-3 py-1.5 hover:bg-white/5 text-sm"
                  >
                    Dashboard
                  </Link>
                  <Link
                    to={`/app/team/manage/${t.id}`}
                    className="rounded-xl border px-3 py-1.5 hover:bg-white/5 text-sm"
                  >
                    Manage
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Teams I'm In */}
      <section className="border rounded-2xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <LogOut className="w-4 h-4" /> Teams I’m In
        </div>
        {memberOf.length === 0 ? (
          <div className="mt-3 text-gray-500">You’re not a member of any teams yet.</div>
        ) : (
          <ul className="mt-3 divide-y divide-white/10">
            {memberOf.map((t) => (
              <li key={t.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-gray-500">Role: {t.role || "member"}</div>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/app/team/${t.id}/dashboard`}
                    className="rounded-xl border px-3 py-1.5 hover:bg-white/5 text-sm"
                  >
                    Open
                  </Link>
                  <button
                    onClick={() => leave(t.id)}
                    className="rounded-xl border border-red-500/50 text-red-400 px-3 py-1.5 hover:bg-red-500/10 text-sm"
                    title="Leave this team"
                  >
                    Leave Team
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}