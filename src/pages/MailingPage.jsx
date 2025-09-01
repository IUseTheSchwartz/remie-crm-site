// File: src/pages/MailingPage.jsx
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { migrateSoldLeads } from "../lib/migrateLeads.js";
import { loadLeads } from "../lib/storage.js";

// Promise timeout helper so UI never "hangs"
function withTimeout(promise, ms = 12000, label = "operation") {
  let t;
  const timeout = new Promise((_, rej) =>
    (t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  );
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

export default function MailingPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  // --- Auth: refresh on mount, focus, visibility changes --------------------
  const loadUser = useCallback(async () => {
    try {
      setAuthChecking(true);
      const { data } = await supabase.auth.getUser();
      setUser(data?.user || null);
    } catch {
      setUser(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    // initial
    loadUser();

    // whenever tab regains focus or becomes visible
    const onFocus = () => loadUser();
    const onVis = () => document.visibilityState === "visible" && loadUser();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    // token auto-refresh can change session silently — poll every 30s
    const t = setInterval(loadUser, 30000);

    // react to explicit auth state changes
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser(session?.user || null);
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
      sub?.subscription?.unsubscribe?.();
    };
  }, [loadUser]);

  // --- Jobs table -----------------------------------------------------------
  const fetchJobs = useCallback(async () => {
    setMsg("");
    setLoading(true);
    try {
      const { data: j, error } = await withTimeout(
        supabase
          .from("mail_jobs")
          .select("id, lead_id, type, status, created_at, error")
          .order("created_at", { ascending: false })
          .limit(50),
        12000,
        "fetch jobs"
      );
      if (error) {
        setMsg("Supabase error: " + error.message);
        setJobs([]);
      } else {
        setJobs(j || []);
      }
    } catch (e) {
      setMsg((e?.message || String(e)));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // --- Migrate SOLD (idempotent) -------------------------------------------
  const doMigrate = async () => {
    setMsg("");
    // grab fresh user right before we start
    const { data } = await supabase.auth.getUser();
    const u = data?.user;
    if (!u?.id) {
      setMsg("Please sign in to migrate SOLD leads.");
      return;
    }

    // local stats for clarity
    const localAll = loadLeads() || [];
    const localSoldCount = localAll.filter(p => p?.status === "sold").length;

    try {
      setMsg(`Migrating SOLD leads → Supabase… (local SOLD: ${localSoldCount})`);
      const result = await withTimeout(migrateSoldLeads(u.id), 15000, "migrate sold leads");
      const parts = [
        `Scanned ${result.scanned}`,
        `SOLD found ${result.soldFound}`,
        `Inserted ${result.inserted}`,
        `Skipped ${result.skipped}`,
      ];
      if (result.note) parts.push(`Note: ${result.note}`);
      setMsg("✅ " + parts.join(" · "));
      await fetchJobs();
    } catch (e) {
      setMsg("Migration error: " + (e?.message || String(e)));
    }
  };

  // --- UI -------------------------------------------------------------------
  return (
    <div className="p-6 text-white">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mailing Activity</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchJobs}
            className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
            title="Reload recent mail jobs"
          >
            Refresh
          </button>
          <button
            onClick={doMigrate}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm"
            title="Migrate only SOLD leads from localStorage to Supabase (idempotent)"
          >
            Migrate SOLD leads (local → Supabase)
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm">
        <div>
          <b>Auth:</b>{" "}
          {authChecking ? "Checking…" : user ? `Signed in as ${user.email}` : "Not signed in"}
        </div>
        {msg && <div className="mt-2 text-amber-300">{msg}</div>}
        <div className="mt-2 text-xs text-white/60">
          After this one-time migration, new SOLD leads are saved to Supabase automatically when you click “Save as SOLD”.
        </div>
      </div>

      {loading ? (
        <div>Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="text-white/70">No mail jobs yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/5">
              <tr>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Lead</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-white/10 hover:bg-white/5">
                  <td className="px-3 py-2 capitalize">{j.type.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2">{j.lead_id || "-"}</td>
                  <td className="px-3 py-2">{j.status}</td>
                  <td className="px-3 py-2">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-rose-300 text-xs">{j.error || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
