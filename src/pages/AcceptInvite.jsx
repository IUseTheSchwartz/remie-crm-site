// File: src/pages/AcceptInvite.jsx
import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { callFn, getCurrentUserId } from "../lib/teamApi";

export default function AcceptInvite() {
  const { token } = useParams();
  const nav = useNavigate();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("checking"); // checking | need_auth | accepting | success | error
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing invite token.");
      setLoading(false);
      return;
    }

    (async () => {
      // Save token in case we need to bounce to login/signup
      localStorage.setItem("pending_invite_token", token);

      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;

      if (!user) {
        setStatus("need_auth");
        setLoading(false);
        return;
      }

      // Already authed → accept now
      await acceptNow();
    })();

    // If user logs in on another tab and comes back, try again
    const { data: sub } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_IN") {
        const saved = localStorage.getItem("pending_invite_token");
        if (saved === token) {
          await acceptNow();
        }
      }
    });

    return () => {
      sub?.subscription?.unsubscribe?.();
    };
    // eslint-disable-next-line
  }, [token]);

  async function acceptNow() {
    try {
      setStatus("accepting");
      setError("");

      const uid = await getCurrentUserId();
      if (!uid) {
        setStatus("need_auth");
        setLoading(false);
        return;
      }

      const res = await callFn("accept-invite", { token });
      if (!res || !res.team_id) {
        throw new Error("Unable to accept invite.");
      }

      setStatus("success");
      localStorage.removeItem("pending_invite_token");
      // Send them to the team dashboard (or your Home)
      setTimeout(() => {
        nav(`/app/team/${res.team_id}/dashboard`, { replace: true });
      }, 600);
    } catch (e) {
      setStatus("error");
      setError(e?.message || "Failed to accept invite.");
    } finally {
      setLoading(false);
    }
  }

  const nextUrl = `/invite/${token}`;

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Join Team</h1>

        {status === "checking" && <p className="text-white/70">Checking invite…</p>}

        {status === "need_auth" && (
          <div className="space-y-3">
            <p className="text-white/70">
              You need to log in (or sign up) to accept this invite.
            </p>
            <div className="flex gap-2">
              <Link
                to={`/login?next=${encodeURIComponent(nextUrl)}`}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Log in
              </Link>
              <Link
                to={`/signup?next=${encodeURIComponent(nextUrl)}`}
                className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
              >
                Sign up
              </Link>
            </div>
          </div>
        )}

        {status === "accepting" && <p className="text-white/70">Accepting your invite…</p>}

        {status === "success" && (
          <p className="text-green-400">Success! Redirecting to your team…</p>
        )}

        {status === "error" && (
          <>
            <p className="text-red-400">Error: {error}</p>
            <button
              onClick={acceptNow}
              className="rounded-xl border border-white/15 px-4 py-2 hover:bg-white/10"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
