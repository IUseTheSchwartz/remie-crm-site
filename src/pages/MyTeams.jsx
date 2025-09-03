import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Plus, Users, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function MyTeams() {
  const [owned, setOwned] = useState([]);
  const [memberOf, setMemberOf] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await getCurrentUserId();

      // Teams I own
      const { data: ownedRows, error: ownedErr } = await supabase
        .from("user_teams")
        .select("role,status,team:teams(id,name,owner_id)")
        .eq("user_id", uid)
        .eq("role", "owner")
        .eq("status", "active");
      if (ownedErr) console.warn(ownedErr);

      // Teams I'm in
      const { data: memberRows, error: memberErr } = await supabase
        .from("user_teams")
        .select("role,status,team:teams(id,name,owner_id)")
        .eq("user_id", uid)
        .eq("role", "member")
        .eq("status", "active");
      if (memberErr) console.warn(memberErr);

      setOwned(ownedRows?.map(r => r.team) || []);
      setMemberOf(memberRows?.map(r => r.team) || []);
      setLoading(false);
    })();
  }, []);

  async function createTeam(e) {
    e.preventDefault();
    if (!teamName.trim()) return;
    try {
      setCreating(true);
      const { team } = await callFn("create-team", { name: teamName.trim() });
      setTeamName("");
      navigate(`/app/team/manage/${team.id}`);
    } catch (e) {
      alert(e.message || "Failed to create team");
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6 space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="w-6 h-6" /> My Teams
          </h1>
          <p className="text-sm text-gray-500">Create or switch between teams you own or belong to.</p>
        </div>
        <form onSubmit={createTeam} className="flex items-center gap-2">
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="New team name"
            className="border rounded-lg px-3 py-2 w-56"
          />
          <button
            disabled={creating || !teamName.trim()}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Create Team
          </button>
        </form>
      </header>

      <section>
        <h2 className="text-lg font-medium mb-3">Teams I Own</h2>
        {owned.length === 0 ? (
          <div className="text-sm text-gray-500">You don’t own any teams yet.</div>
        ) : (
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {owned.map((t) => (
              <li key={t.id} className="border rounded-2xl p-4 flex flex-col gap-3">
                <div className="font-medium">{t.name}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigate(`/app/team/manage/${t.id}`)}
                    className="px-3 py-2 rounded-xl border hover:bg-gray-50"
                  >
                    Manage
                  </button>
                  <button
                    onClick={() => navigate(`/app/team/${t.id}/dashboard`)}
                    className="px-3 py-2 rounded-xl border hover:bg-gray-50 inline-flex items-center gap-1"
                  >
                    Dashboard <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Teams I’m In</h2>
        {memberOf.length === 0 ? (
          <div className="text-sm text-gray-500">You’re not a member of any other teams.</div>
        ) : (
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {memberOf.map((t) => (
              <li key={t.id} className="border rounded-2xl p-4 flex items-center justify-between">
                <div className="font-medium">{t.name}</div>
                <button
                  onClick={() => navigate(`/app/team/${t.id}/dashboard`)}
                  className="px-3 py-2 rounded-xl border hover:bg-gray-50 inline-flex items-center gap-1"
                >
                  Open <ArrowRight className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
