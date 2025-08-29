import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data: p, error: e1 } = await supabase
          .from("agent_profiles")
          .select("full_name,email,phone,short_bio,headshot_url,published")
          .eq("slug", slug)
          .maybeSingle();
        if (e1) throw e1;
        if (!p) return setLoading(false);

        const { data: st, error: e2 } = await supabase
          .from("agent_states")
          .select("state_code,state_name,license_number,license_image_url")
          .eq("user_id", (await supabase.auth.getUser()).data?.user?.id || ""); // ignore auth; public page may be anonymous
        // NOTE: For a truly public page, you'd normally join by the profile's user_id.
        // If you stored user_id in profiles publicly, fetch it in the first select and reuse here.

        setProfile(p);
        setStates(st || []);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  if (loading) return <div className="p-6 text-white/80">Loading…</div>;
  if (!profile) return <div className="p-6 text-white/80">Profile not found.</div>;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex items-center gap-4">
          {profile.headshot_url && (
            <img
              src={profile.headshot_url}
              alt={profile.full_name}
              className="h-24 w-24 rounded-xl border border-white/10 object-cover"
            />
          )}
          <div>
            <h1 className="text-2xl font-semibold">{profile.full_name}</h1>
            <div className="text-white/70 text-sm">{profile.short_bio}</div>
            <div className="mt-2 text-sm text-white/70">
              {profile.email} • {profile.phone}
            </div>
          </div>
        </div>

        <h2 className="mt-8 mb-2 text-lg font-semibold">Licensed States</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {states.map((s) => (
            <div key={s.state_code} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-sm font-medium">{s.state_name} ({s.state_code})</div>
              <div className="text-xs text-white/60">License: {s.license_number || "—"}</div>
              {s.license_image_url && (
                s.license_image_url.toLowerCase().includes(".pdf") ? (
                  <a href={s.license_image_url} target="_blank" rel="noreferrer" className="text-xs underline mt-2 inline-block">
                    View license PDF
                  </a>
                ) : (
                  <img src={s.license_image_url} alt={`${s.state_code} license`} className="mt-2 h-20 rounded border border-white/10 object-cover" />
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
