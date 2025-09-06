import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function SupportInbox() {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("support_tickets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (!error) setTickets(data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("support_tickets")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "support_tickets" },
        () => load()
      )
      .subscribe();
    return () => ch.unsubscribe();
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Support Inbox</h1>
      {loading ? <p>Loading…</p> : null}
      <div className="grid gap-3">
        {tickets.map((t) => (
          <div key={t.id} className="border rounded p-3">
            <div className="flex justify-between">
              <div>
                <div className="font-medium">{t.subject || "(no subject)"} • <span className="uppercase">{t.severity}</span></div>
                <div className="text-sm text-gray-600">
                  {t.name} &lt;{t.email}&gt; • {new Date(t.created_at).toLocaleString()}
                </div>
              </div>
              <div className="text-sm">{t.status}</div>
            </div>
            <pre className="mt-2 whitespace-pre-wrap">{t.message}</pre>
            {t.path ? <div className="text-xs text-gray-500 mt-2">Path: {t.path}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
