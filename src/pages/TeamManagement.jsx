import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Link } from "react-router-dom";
import { Users, Copy, Trash2, Check, Shield } from "lucide-react";

export default function TeamManagement() {
  const { teamId } = useParams();
  const [me, setMe] = useState(null);
  const [team, setTeam] = useState(null);
  const [name, setName] = useState("");
  const [members, setMembers] = useState([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copyOk, setCopyOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const isOwner = useMemo(() => me && team && team.owner_id === me, [me, team]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await getCurrentUserId();
      setMe(uid);

      const { data: t, error: tErr } = await supabase
        .from("teams")
        .select("*")
        .eq("id", teamId)
        .single();
      if (tErr) {
        console.warn(tErr);
        setLoading(false);
        return;
      }
      setTeam(t);
      setName(t.name);

      // Load members (join to profiles for display)
      const { data: rows, error: mErr } = await supabase
        .from("user_teams")
        .select(`
          user_id, role, status, joined_at,
          profile:profiles(id, full_name, email)
        `)
        .eq("team_id", teamId)
        .in("status", ["active", "invited"]); // show both
      if (mErr) console.warn(mErr);
      setMembers(rows || []);
      setLoading(false);
    })();
  }, [teamId]);

  async function createInvite() {
    try {
      const res = await callFn("create-invite", { team_id: teamId });
      setInviteUrl(res.acceptUrl);
      setCopyOk(false);
    } catch (e) {
      alert(e.message || "Failed to create invite");
    }
  }

  async function removeMember(userId) {
    if (!confirm("Remove this member from the team?")) return;
    try {
      await callFn("remove-member", { team_id: teamId, user_id: userId });
      // refresh list
      const { data: rows } = await supabase
        .from("user_teams")
        .select(`user_id, role, status, joined_at, profile:profiles(id, full_name, email)`)
        .eq("team_id", teamId)
        .in("status", ["active", "invited"]);
      setMembers(rows || []);
    } catch (e) {
      alert(e.message || "Remove failed");
    }
  }

  async function saveName() {
    try {
      if (!isOwner) return;
      const { error } = await supabase.from("teams").update({ name }).eq("id", teamId);
      if (error) throw error;
      setTeam((t) => ({ ...t, name }));
    } catch (e) {
      alert(e.message || "Failed to rename");
    }
  }

  if (loading) return <div className="p-6">Loading...</div>;
  if (!team) return <div className="p-6">Team not found.</div>;
  if (!isOwner)
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-amber-600"><Shield className="w-5 h-5" /> Owner-only</div>
        <p className="text-gray-600 mt-2">You’re not the owner of this team.</p>
        <Link to={`/app/team/${teamId}/dashboard`} className="underline mt-3 inline-block">
          Go to Team Dashboard
        </Link>
      </div>
    );

  const activeSeats = members.filter(m => m.role === "member" && m.status === "active").length;

  return (
    <div className="p-6 space-y-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> Manage Team
        </h1>
        <p className="text-sm text-gray-500">Invite members, rename team, and view seats billed.</p>
      </header>

      <section className="border rounded-2xl p-4 space-y-3">
        <label className="text-sm text-gray-600">Team Name</label>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border rounded-lg px-3 py-2 w-full max-w-md"
          />
          <button onClick={saveName} className="px-4 py-2 rounded-xl border hover:bg-gray-50">Save</button>
        </div>
        <div className="text-sm text-gray-600">
          Seats billed: <span className="font-medium">{activeSeats}</span> (members only)
        </div>
      </section>

      <section className="border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium">Invite link</div>
          <button onClick={createInvite} className="px-3 py-2 rounded-xl border hover:bg-gray-50">Generate</button>
        </div>
        {inviteUrl && (
          <div className="flex gap-2 items-center">
            <input readOnly value={inviteUrl} className="border rounded-lg px-3 py-2 w-full" />
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                setCopyOk(true);
                setTimeout(() => setCopyOk(false), 1200);
              }}
              className="px-3 py-2 rounded-xl border hover:bg-gray-50 inline-flex items-center gap-2"
            >
              <Copy className="w-4 h-4" /> Copy
            </button>
            {copyOk && <span className="text-green-600 inline-flex items-center gap-1"><Check className="w-4 h-4" /> Copied</span>}
          </div>
        )}
      </section>

      <section className="border rounded-2xl p-4">
        <div className="font-medium mb-3">Members</div>
        <div className="overflow-auto">
          <table className="min-w-[600px] w-full text-sm">
            <thead className="text-left text-gray-600">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-t">
                  <td className="py-2 pr-3">{m.profile?.full_name || m.user_id.slice(0, 6)}</td>
                  <td className="py-2 pr-3">{m.profile?.email || "—"}</td>
                  <td className="py-2 pr-3">{m.role}</td>
                  <td className="py-2 pr-3">{m.status}</td>
                  <td className="py-2 pr-3 text-right">
                    {m.role === "member" && m.status === "active" && (
                      <button
                        onClick={() => removeMember(m.user_id)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border hover:bg-gray-50 text-red-600"
                      >
                        <Trash2 className="w-4 h-4" /> Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr><td className="py-6 text-gray-500">No members yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
