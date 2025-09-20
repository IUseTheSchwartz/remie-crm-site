// File: src/pages/TeamManagement.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId, callFn } from "../lib/teamApi";
import { Users, Copy, Trash2, Check, Shield, Plus } from "lucide-react";

const BONUS_EMAIL = "jacobprieto@gmail.com";
const BONUS_SEATS = 10;
const SEAT_PRICE = 50; // USD per month

export default function TeamManagement() {
  const { teamId } = useParams();

  const [me, setMe] = useState(null);
  const [myEmail, setMyEmail] = useState("");
  const [team, setTeam] = useState(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);

  // members
  const [members, setMembers] = useState([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copyOk, setCopyOk] = useState(false);

  // seats (DB-sourced)
  const [seatsPurchased, setSeatsPurchased] = useState(0);
  const [seatsUsed, setSeatsUsed] = useState(0);
  const [seatsAvailable, setSeatsAvailable] = useState(0);

  // simple “add seats” box (defaults to 2)
  const [additionalSeats, setAdditionalSeats] = useState(2);

  const isOwner = useMemo(() => me && team && team.owner_id === me, [me, team]);
  const ownerGetsBonus = isOwner && myEmail.toLowerCase() === BONUS_EMAIL.toLowerCase();

  // Effective numbers for display (bonus is free / not billed)
  const effectivePurchased = Math.max(seatsPurchased + (ownerGetsBonus ? BONUS_SEATS : 0), 0);
  const effectiveAvailable = Math.max(effectivePurchased - seatsUsed, 0);

  useEffect(() => {
    (async () => {
      setLoading(true);

      const uid = await getCurrentUserId();
      setMe(uid);

      const { data: auth } = await supabase.auth.getUser();
      const email = auth?.user?.email || "";
      setMyEmail(email);

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

    const onFocus = () => refreshSeatCounts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line
  }, [teamId]);

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
        alert("No seats available. Buy more seats first.");
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

  // One-click repair for wrong saved subscription/customer mapping
  async function fixStripeSubscription() {
    try {
      const res = await callFn("fix-team-subscription", { team_id: teamId });
      const msg = res?.message || "Fixed.";
      alert(`Fix result: ${msg}`);
      await refreshSeatCounts();
    } catch (e) {
      alert(e.message || "Fix failed");
    }
  }

  // Buy seats = increase paid seats by N
  async function buySeats() {
    try {
      const add = Math.max(parseInt(additionalSeats || "0", 10), 0);
      if (!add) {
        alert("Enter how many seats to buy.");
        return;
      }
      const targetPaid = Math.max(seatsUsed, (seatsPurchased || 0) + add);
      const res = await callFn("update-seats", { team_id: teamId, seats: targetPaid });
      if (res?.seatCounts) {
        setSeatsPurchased(res.seatCounts.seats_purchased || 0);
        setSeatsUsed(res.seatCounts.seats_used || 0);
        setSeatsAvailable(res.seatCounts.seats_available || 0);
        alert(`Purchased ${add} seat${add === 1 ? "" : "s"}.`);
      } else {
        await refreshSeatCounts();
        alert(`Purchased ${add} seat${add === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      alert(e.message || "Failed to buy seats");
    }
  }

  if (loading) return <div className="p-6">Loading...</div>;
  if (!team) return <div className="p-6">Team not found.</div>;
  if (!isOwner) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-amber-600">
          <Shield className="w-5 h-5" /> Owner-only
        </div>
        <p className="text-gray-600 mt-2">You’re not the owner of this team.</p>
        <Link to={`/app/team/${teamId}/dashboard`} className="underline mt-3 inline-block">
          Go to Team Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> Manage Team
        </h1>
        <p className="text-sm text-gray-500">
          Buy seats, invite members, and manage your team.
        </p>
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
          <button onClick={saveName} className="px-4 py-2 rounded-xl border hover:bg-gray-50">
            Save
          </button>
        </div>
      </section>

      {/* Seats: only input + Buy + Fix */}
      <section className="border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-600">Seats</div>
          <button
            onClick={fixStripeSubscription}
            className="text-xs px-3 py-1.5 rounded-xl border hover:bg-gray-50"
            title="Repair the saved Stripe subscription id if it doesn't match this team's customer"
          >
            Fix Stripe Subscription
          </button>
        </div>

        <div className="text-lg font-semibold flex items-center gap-2">
          <span>
            {effectivePurchased} purchased
            {ownerGetsBonus && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-white/10">
                includes +{BONUS_SEATS} free
              </span>
            )}
          </span>
          <span>• {seatsUsed} used • {Math.max(effectivePurchased - seatsUsed, 0)} available</span>
        </div>
        <div className="text-xs text-gray-500">
          Billing: ${SEAT_PRICE}/seat/month (owner not billed as a seat). Free bonus seats aren’t billed.
        </div>

        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            value={additionalSeats}
            onChange={(e) => setAdditionalSeats(parseInt(e.target.value || "0", 10))}
            className="w-28 px-3 py-2 rounded-xl border"
            title="How many new paid seats to add"
          />
          <button
            onClick={buySeats}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border hover:bg-gray-50"
            title="Buy seats now"
          >
            Buy (${SEAT_PRICE}/seat)
          </button>
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
            <input
              readOnly
              value={inviteUrl}
              className="border rounded-lg px-3 py-2 w-full"
            />
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
            {copyOk && (
              <span className="text-green-600 inline-flex items-center gap-1">
                <Check className="w-4 h-4" /> Copied
              </span>
            )}
          </div>
        )}
      </section>

      {/* Members list (never blank rows) */}
      <section className="border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium">Members</div>
        </div>
        <ul className="divide-y">
          {members.map((m) => {
            const label =
              m?.profile?.full_name ||
              m?.email ||
              m?.profile?.email ||
              "(pending)";
            return (
              <li key={m.user_id || label} className="py-2 flex justify-between items-center">
                <span className="text-sm">{label}</span>
                <button
                  onClick={() => removeMember(m.user_id)}
                  className="text-red-500 hover:text-red-700 flex items-center gap-1"
                >
                  <Trash2 className="w-4 h-4" /> Remove
                </button>
              </li>
            );
          })}
          {members.length === 0 && (
            <li className="py-6 text-gray-500">No members yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
