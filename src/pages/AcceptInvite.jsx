// File: src/pages/AcceptInvite.jsx
import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

export default function AcceptInvite() {
  const { token } = useParams();
  const nav = useNavigate();

  const [phase, setPhase] = useState("checking"); // checking | need_auth | accepting | success | error
  const [errorMsg, setErrorMsg] = useState("");

  const selfUrl = `/invite/${token}`;

  useEffect(() => {
    if (!token) {
      setPhase("error");
      setErrorMsg("Missing invite token.");
      return;
    }

    // Remember token so we can finish after auth
    localStorage.setItem("pending_invite_token", token);

    (async () => {
      const { data } = await supabase.auth.getUser();
      const user = data?.user;

      if (!user) {
        setPhase("need_auth");
        return;
      }

      // already signed in → accept now
      acceptNow(user);
    })();

    // If auth state changes (user logs in), try again
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN") {
        const saved = localStorage.getItem("pending_invite_token");
        if (saved === token && session?.user) {
          acceptNow(session.user);
        }
      }
    });

    return () => {
      sub?.subscription?.unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function acceptNow(user) {
    try {
      setPhase("accepting");
      setErrorMsg("");

      // Get access token + confirm uid
      const { data: s } = await supabase.auth.getSession();
      const accessToken = s?.session?.access_token || null;
      const uid = user?.id;

      if (!accessToken || !uid) {
        setPhase("need_auth");
        return;
      }

      // Call Netlify function directly with proper auth headers
      const resp = await fetch("/.netlify/functions/accept-invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-User-Id": uid,
        },
        body: JSON.stringify({ token }),
      });

      // Try to parse JSON either way
      let payload = null;
      try {
        payload = await resp.json();
      } catch {
        /* no-op */
      }

      if (!resp.ok) {
        // Handle common auth cases
        if (resp.status === 401 || resp.status === 403) {
          setPhase("need_auth");
          setErrorMsg(payload?.message || "Please log in to accept this invite.");
          return;
        }
        setPhase("error");
        setErrorMsg(payload?.message || payload?.error || `Join failed (HTTP ${resp.status}).`);
        return;
      }

      const teamId = payload?.team_id || payload?.teamId;
      if (!teamId) {
        setPhase("error");
        setErrorMsg("Invite accepted but team id missing.");
        return;
      }

      // Cleanup + redirect
      localStorage.removeItem("pending_invite_token");
      setPhase("success");
      setTimeout(() => {
        nav(`/app/team/${teamId}/dashboard`, { replace: true });
      }, 400);
    } catch (e) {
      setPhase("error");
      setErrorMsg(e?.message || "Unexpected error while accepting the invite.");
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Join Team</h1>

        {phase === "checking" && <p className="text-white/70">Checking invite…</p>}

        {phase === "need_auth" && (
          <div className="space-y-3">
            {errorMsg && <p className="text-red-400">{errorMsg}</p>}
            <p className="text-white/70">You need to log in (or sign up) to accept this invite.</p>
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
              After you finish, you’ll come back here automatically to join the team.
            </p>
          </div>
        )}

        {phase === "accepting" && <p className="text-white/70">Accepting your invite…</p>}

        {phase === "success" && <p className="text-green-400">Success! Redirecting…</p>}

        {phase === "error" && (
          <div className="space-y-3">
            <p className="text-red-400">{errorMsg || "Something went wrong."}</p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const { data } = await supabase.auth.getUser();
                  if (!data?.user) {
                    setPhase("need_auth");
                    return;
                  }
                  acceptNow(data.user);
                }}
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
