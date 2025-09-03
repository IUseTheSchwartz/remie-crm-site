// File: src/pages/AcceptInvite.jsx
import { useEffect, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { callFn, getCurrentUserId } from "../lib/teamApi";

export default function AcceptInvite() {
  const { token } = useParams();
  const nav = useNavigate();
  const loc = useLocation();

  const [status, setStatus] = useState("checking"); // checking | need_auth | accepting | success | error
  const [errorMsg, setErrorMsg] = useState("");

  // Build this page's URL for ?next=
  const selfUrl = `/invite/${token}`;

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorMsg("Missing invite token.");
      return;
    }

    // Remember token so we can finish after auth
    localStorage.setItem("pending_invite_token", token);

    (async () => {
      // Check current session
      const { data: sessionRes } = await supabase.auth.getSession();
      const session = sessionRes?.session;

      if (!session?.user?.id) {
        setStatus("need_auth");
        return;
      }

      // Already signed in → accept now
      await acceptNow();
    })();

    // If auth state changes (e.g., user logs in in this tab), try again
    const { data: sub } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_IN") {
        const saved = localStorage.getItem("pending_invite_token");
        if (saved === token) {
          await acceptNow();
        }
      }
    });

    return () => sub?.subscription?.unsubscribe?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function acceptNow() {
    try {
      setStatus("accepting");
      setErrorMsg("");

      // Get user id (fallback to session if helper fails)
      let uid = null;
      try {
        uid = await getCurrentUserId();
      } catch {}
      if (!uid) {
        const { data: s } = await supabase.auth.getSession();
        uid = s?.session?.user?.id || null;
      }
      if (!uid) {
        setStatus("need_auth");
        return;
      }

      // Call the function to accept
      const res = await callFn("accept-invite", { token });
      if (!res || !res.team_id) {
        throw new Error(res?.error || "Unable to accept invite.");
      }

      // Cleanup + go to team
      localStorage.removeItem("pending_invite_token");
      setStatus("success");
      setTimeout(() => {
        nav(`/app/team/${res.team_id}/dashboard`, { replace: true });
      }, 500);
    } catch (e) {
      setStatus("error");
      // try to surface server messages (e.g., 401/403/409 strings)
      setErrorMsg(e?.message || "Failed to accept invite.");
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Join Team</h1>

        {status === "checking" && (
          <p className="text-white/70">Checking invite…</p>
        )}

        {status === "need_auth" && (
          <div className="space-y-3">
            <p className="text-white/70">
              You need to log in (or sign up) to accept this invite.
            </p>
            <div className="flex gap-2">
              <Link
                to={`/login?next=${encodeURIComponent(selfUrl)}`}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Log in
              </Link>
              <Link
                to={`/signup?next=${encodeURIComponent(selfUrl)}`}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Sign up
              </Link>
            </div>
            <p className="text-xs text-white/40">
              After you finish, you’ll come back here to join the team.
            </p>
          </div>
        )}

        {status === "accepting" && (
          <p className="text-white/70">Accepting your invite…</p>
        )}

        {status === "success" && (
          <p className="text-green-400">Success! Redirecting to your team…</p>
        )}

        {status === "error" && (
          <div className="space-y-3">
            <p className="text-red-400">
              {errorMsg || "Something went wrong while accepting the invite."}
            </p>
            <div className="flex gap-2">
              <button
                onClick={acceptNow}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Try again
              </button>
              <Link
                to={`/login?next=${encodeURIComponent(selfUrl)}`}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Log in
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
