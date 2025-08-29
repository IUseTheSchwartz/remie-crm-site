import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import supabase from "../lib/supabaseClient";

export default function AgentPublic() {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState(null);
  const [states, setStates] = useState([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data: prof, error } = await supabase
          .from("agent_profiles")
          .select(
            "user_id, slug, full_name, email, phone, short_bio, npn, published, headshot_url"
          )
          .eq("slug", slug)
          .eq("published", true)
          .maybeSingle();

        if (error) throw error;
        setAgent(prof || null);

        if (prof?.user_id) {
          const { data: sts, error: se } = await supabase
            .from("agent_states")
            .select("state_code")
            .eq("user_id", prof.user_id);
          if (se) throw se;
          setStates(sts?.map((r) => r.state_code) || []);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <p>Loading…</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold">Agent not found</h1>
          <p className="opacity-70">This profile may be unpublished or the link is incorrect.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <img
            src={agent.headshot_url || ""}
            alt={agent.full_name}
            className="h-40 w-40 rounded-2xl object-cover border border-white/10"
          />
          <div className="flex-1">
            <h1 className="text-3xl font-semibold">{agent.full_name}</h1>
            <p className="mt-1 text-white/70">{agent.short_bio}</p>

            <div className="mt-4 grid gap-1 text-sm">
              {agent.phone && (
                <a className="underline opacity-90" href={`tel:${agent.phone}`}>
                  {agent.phone}
                </a>
              )}
              {agent.email && (
                <a className="underline opacity-90" href={`mailto:${agent.email}`}>
                  {agent.email}
                </a>
              )}
              {agent.npn && (
                <div className="opacity-70">NPN: {agent.npn}</div>
              )}
            </div>

            {!!states.length && (
              <div className="mt-6">
                <div className="text-sm mb-2 opacity-80">Licensed in</div>
                <div className="flex flex-wrap gap-2">
                  {states.map((c) => (
                    <span
                      key={c}
                      className="text-xs rounded-full border border-white/15 px-2 py-1 bg-white/5"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
