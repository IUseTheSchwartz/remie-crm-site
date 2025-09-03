// File: src/pages/TeamManagement.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Users, Copy, Trash2, Check, Shield, Plus, CreditCard, RefreshCw } from "lucide-react";

const BONUS_EMAIL = "jacobprieto@gmail.com";
const BONUS_SEATS = 10;
const SEAT_PRICE = 50; // USD per month

export default function TeamManagement() {
  const { teamId } = useParams();
  const [me, setMe] = useState(null);
  const [myEmail, setMyEmail] = useState("");
  const [team, setTeam] = useState(null);
  const [name, setName] = useState("");
  const [members, setMembers] = useState([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copyOk, setCopyOk] = useState(false);
  const [loading, setLoading] = useState(true);

  // seats from DB (paid + usage)
  const [seatsPurchased, setSeatsPurchased] = useState(0);
  const [seatsUsed, setSeatsUsed] = useState(0);
  const [seatsAvailable, setSeatsAvailable] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const isOwner = useMemo(() => me && team && team.owner_id === me, [me, team]);
  const ownerGetsBonus = isOwner && myEmail.toLowerCase() === BONUS_EMAIL.toLowerCase();

  // Effective numbers used by UI logic
  const effectivePurchased = Math.max(seatsPurchased + (ownerGetsBonus ? BONUS_SEATS : 0), 0);
  const effectiveAvailable = Math.max(effectivePurchased - seatsUsed, 0);

  useEffect(() => {
    (async () => {
      setLoading(true);

      // who am I?
      const uid = await getCurrentUserId();
      setMe(uid);

      // my email (from auth)
      const { data: auth } = await supabase.auth.getUser();
      const email = auth?.user?.email || "";
      setMyEmail(email);

      // team record
      const { data: t } = await supabase
        .from("teams")
        .select("*")
        .eq("id", teamId)
        .single();
      setTeam(t || null);
      setName(t?.name || "");

      await refreshMembers();
      await refreshSeatCounts();

      setLoading(false);
    })();

    // refresh seats when user returns from Stripe portal
    const onFocus = () => { refreshSeatCounts(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line
  }, [teamId]);

  // Load members via server function (service role)
  async function refreshMembers() {
    try {
      const res = await callFn("list-members", { team_id: teamId });
      setMembers(res?.members || []);
    } catch (e) {
      console.warn("[TeamManagement] list-members failed:", e?.message || e);
      setMembers([]);
    }
  }

  async function refreshSeatCounts() {
    const { data: counts } = await supabase
      .from("team_seat_counts")
      .select("*")
      .eq("team_id", teamId)
      .single();

    if (counts) {
      setSeatsPurchased(counts.seats_purchased || 0);
      setSeatsUsed(counts.seats_used || 0);
      setSeatsAvailable(counts.seats_available || 0);
    }
  }

  async function createInvite() {
    try {
      if (effectiveAvailable <= 0) {
        alert("No seats available. Click Buy Seats to add more.");
        return;
      }
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
      await refreshMembers();
      await refreshSeatCounts();
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

  function openBillingPortal() {
    window.location.href = "https://billing.stripe.com/p/login/00w9AV5CGaQ61oqc0Q8Ra00";
  }

  async function syncSeatsFromStripe() {
    try {
      setSyncing(true);
      const res = await callFn("sync-seats-now", { team_id: teamId });
      if (res?.seatCounts) {
        setSeatsPurchased(res.seatCounts.seats_purchased || 0);
        setSeatsUsed(res.seatCounts.seats_used || 0);
        setSeatsAvailable(res.seatCounts.seats_available || 0);
      } else {
        await refreshSeatCounts();
      }
    } catch (e) {
      alert(e.message || "Failed to refresh seats");
    } finally {
      setSyncing(false);
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

  return (
    <div className="p-6 space-y-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> Manage Team
        </h1>
        <p className="text-sm text-gray-500">Buy seats in Stripe, then invite members to fill them.</p>
      </header>

      {/* Team name */}
      <section className="border rounded-2xl p-4 space-y-3">
        <label className="text-sm text-gray-600">Team Name</label>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border rounded-lg px-3 py-2 w-full max-w-md"
          />
        </div>
        <div>
          <button onClick={saveName} className="px-4 py-2 rounded-xl border hover:bg-gray-50">Save</button>
        </div>
      </section>

      {/* Seats (Billing Portal + Refresh) */}
      <section className="border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-600">Seats</div>
            <div className="text-lg font-semibold flex items-center gap-2">
              <span>
                {effectivePurchased} purchased
                {ownerGetsBonus && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-white/10">
                    includes +{BONUS_SEATS} free
                  </span>
                )}
              </span>
              <span>• {seatsUsed} used • {effectiveAvailable} available</span>
            </div>
            <div className="text-xs text-gray-500">
              Billing: ${SEAT_PRICE}/seat/month (owner not billed as a seat). Only paid seats are billed; free seats are not charged.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openBillingPortal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border hover:bg-gray-50"
              title="Open Stripe to buy or reduce seats and add/update your card"
            >
              <CreditCard className="w-4 h-4" /> Buy Seats
            </button>
            <button
              onClick={syncSeatsFromStripe}
              disabled={syncing}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border hover:bg-gray-50 disabled:opacity-50"
              title="Refresh seat count from Stripe"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        </div>
      </section>

      {/* Invite flow */}
      <section className="border rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">Invite Members</div>
          <button
            onClick={createInvite}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border hover:bg-gray-50"
            title="Creates a one-time invite link. Accepting consumes one seat."
          >
            <Plus className="w-4 h-4" /> Generate Invite Link
          </button>
        </div>

        {inviteUrl && (
          <div className="mt-3 flex gap-2 items-center">
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

      {/* Members table */}
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
              {members.map((m) => {
                const email = m?.profile?.email || "—";
                const name =
                  m?.profile?.full_name ||
                  (email !== "—" ? email.split("@")[0] : (m.user_id?.slice(0, 6) || "—"));
                const statusText = m?.display_status || m?.status || "—";

                return (
                  <tr key={m.user_id} className="border-t">
                    <td className="py-2 pr-3">{name}</td>
                    <td className="py-2 pr-3">{email}</td>
                    <td className="py-2 pr-3">{m.role}</td>
                    <td className="py-2 pr-3">{statusText}</td>
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
                );
              })}
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
