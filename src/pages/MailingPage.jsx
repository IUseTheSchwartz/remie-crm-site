// File: src/pages/MailingPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { Mail, Loader, CheckCircle, XCircle, Clock } from "lucide-react";

export default function MailingPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("mail_jobs")
        .select("id, lead_id, type, status, created_at, error, payload")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && data) setJobs(data);
      setLoading(false);
    })();
  }, []);

  const Icon = ({ s }) =>
    s === "sent" ? <CheckCircle className="text-emerald-400" size={16}/> :
    s === "failed" ? <XCircle className="text-rose-400" size={16}/> :
    s === "processing" ? <Loader className="animate-spin text-indigo-400" size={16}/> :
    <Clock className="text-yellow-400" size={16}/>;

  return (
    <div className="p-6 text-white">
      <h1 className="text-2xl font-semibold mb-4 flex items-center gap-2">
        <Mail size={24}/> Mailing Activity
      </h1>

      {loading ? (
        <div>Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="text-white/60">No mail jobs yet.</div>
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
                  <td className="px-3 py-2 capitalize">{j.type.replace(/_/g," ")}</td>
                  <td className="px-3 py-2">{j.lead_id || "-"}</td>
                  <td className="px-3 py-2 flex items-center gap-1"><Icon s={j.status}/> {j.status}</td>
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
