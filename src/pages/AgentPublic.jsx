// File: src/pages/AgentPublic.jsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../supabaseClient";

function Badge({ children }) {
  return <span className="px-2 py-1 rounded-full border text-sm">{children}</span>;
}

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("slug", slug)
        .eq("published", true)
        .maybeSingle();

      if (!error && data) {
        setProfile(data);
        const { data: st } = await supabase
          .from("agent_states")
          .select("state_code")
          .eq("user_id", data.user_id);
        setStates(st?.map((r) => r.state_code) || []);
      }
      setLoading(false);
    })();
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-white">
        Loading…
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="max-w-3xl mx-auto p-6 text-white">
        <h1 className="text-xl font-semibold mb-2">Profile not found</h1>
        <p className="text-white/70">This page may be unpublished or does not exist.</p>
        <Link className="text-indigo-300 underline" to="/">Back home</Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 text-white">
      <div className="flex gap-6 items-start">
        {profile.headshot_url ? (
          <img
            src={profile.headshot_url}
            alt={profile.full_name}
            className="w-32 h-32 rounded-xl object-cover"
          />
        ) : (
          <div className="w-32 h-32 rounded-xl bg-white/10" />
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{profile.full_name}</h1>
          {profile.npn && <div className="text-white/70">NPN: {profile.npn}</div>}
          <p className="mt-3">{profile.short_bio || ""}</p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {profile.email && <Badge>{profile.email}</Badge>}
            {profile.phone && <Badge>{profile.phone}</Badge>}
          </div>
          {!!states.length && (
            <div className="mt-5">
              <div className="text-sm text-white/70 mb-1">Licensed states</div>
              <div className="flex flex-wrap gap-2">
                {states.map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
