// File: src/pages/MailingPage.jsx
import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { migrateSoldLeads } from "../lib/migrateLeads.js";

export default function MailingPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false); // session hydration gate
  const authTimer = useRef(null);

  // 1) Hydrate session and listen for changes
  const hydrateAuth = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user) setUser(data.session.user);
      setAuthReady(true);
    } catch {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    // initial hydration
    hydrateAuth();
    // subscribe to changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      setAuthReady(true);
    });
    // extra grace: some browsers restore async — give it up to 1200ms
    authTimer.current = setTimeout(() => setAuthReady(true), 1200);
    return () => {
      sub?.subscription?.unsubscribe?.();
      if (authTimer.current) clearTimeout(authTimer.current);
    };
  }, [hydrateAuth]);

  // 2) Jobs fetch
  const fetchJobs = useCallback(async () => {
    setMsg("");
    setLoading(true);
    try {
      const { data: j, error } = await supabase
        .from("mail_jobs")
        .select("id, lead_id, type, status, created_at, error")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        setMsg("Supabase error: " + error.message);
        setJobs([]);
      } else {
        setJobs(j || []);
      }
    } catch (e) {
      setMsg("Unexpected error: " + (e?.message || e));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // 3) Migrate button
  const doMigrate = async () => {
    setMsg("");
    if (!authReady) {
      setMsg("Checking sign-in…");
      return;
    }
    if (!user?.id) {
      setMsg("Please sign in to migrate SOLD leads.");
      return;
    }
    try {
      setMsg("Migrating SOLD leads → Supabase…");
      const r = await migrateSoldLeads(user.id);
      setMsg(`✅ Scanned ${r.scanned}; SOLD found ${r.soldFound}; inserted ${r.inserted}; skipped ${r.skipped}.`);
      await fetchJobs();
    } catch (e) {
      setMsg("Migration error: " + (e?.message || e));
    }
  };

  return (
    <div className="p-6 text-white">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mailing Activity</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchJobs}
            className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
          >
            Refresh
          </button>
          <button
            onClick={doMigrate}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm"
            title="Migrate only SOLD leads from localStorage to Supabase (idempotent)"
            disabled={!authReady}
          >
            Migrate SOLD leads (local → Supabase)
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm">
        <div>
          <b>Auth:</b>{" "}
          {!authReady ? "Checking…" : user ? `Signed in as ${user.email}` : "Not signed in"}
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
              {jobs.map(j => (
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
