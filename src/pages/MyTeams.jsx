// File: src/pages/MyTeams.jsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Users, Crown, LogOut, Plus } from "lucide-react";

export default function MyTeams() {
  const [me, setMe] = useState(null);
  const [owned, setOwned] = useState([]);
  const [memberOf, setMemberOf] = useState([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await getCurrentUserId();
      setMe(uid);

      // Teams I own
      const { data: own } = await supabase
        .from("teams")
        .select("id, name, created_at")
        .eq("owner_id", uid)
        .order("created_at", { ascending: false });

      // Teams I'm in (not owner)
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

  async function leave(teamId) {
    if (!confirm("Leave this team? You’ll lose access immediately.")) return;
    try {
      await callFn("leave-team", { team_id: teamId });
      // refresh lists
      const uid = me;
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
    } catch (e) {
      alert(e.message || "Failed to leave team");
    }
  }

  if (loading) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> My Teams
        </h1>
        <button
          onClick={() => nav("/app/team/create")}
          className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 hover:bg-white/5"
        >
          <Plus className="w-4 h-4" /> Create Team
        </button>
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
