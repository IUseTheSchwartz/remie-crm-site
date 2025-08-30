// File: src/pages/AgentPublic.jsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { ExternalLink, Phone, Mail, Shield } from "lucide-react";

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const REGULATOR_LINKS = {
  FL: "https://licenseesearch.fldfs.com/",
  TX: "https://txapps.texas.gov/NASApp/tdi/TdiARManager",
  CA: "https://www.insurance.ca.gov/0200-industry/0008-education-provider/producer-licensing.cfm",
};

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const { data: prof, error: e1 } = await supabase
          .from("agent_profiles")
          .select("user_id, full_name, email, phone, short_bio, headshot_url, npn, published, slug")
          .eq("slug", slug)
          .maybeSingle();

        if (e1) throw e1;
        if (!prof) {
          if (mounted) setProfile(null);
          return;
        }
        if (mounted) setProfile(prof);

        // NOTE: selecting state_name and licence_image_url (your schema)
        const { data: st, error: e2 } = await supabase
          .from("agent_states")
          .select("state_code, state_name, license_number, licence_image_url")
          .eq("user_id", prof.user_id);

        if (e2) {
          console.warn("agent_states select blocked or failed:", e2);
          if (mounted) setStates([]);
        } else if (mounted) {
          setStates(st || []);
        }
      } catch (err) {
        console.error(err);
        if (mounted) {
          setProfile(null);
          setStates([]);
          setLoadError("Unable to load this agent page.");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [slug]);

  const heroGradient = "bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10";

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <div className="text-white/70">Loading…</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
          <div className="text-lg font-semibold">Page not found</div>
          <div className="mt-1 text-sm text-white/70">
            {loadError || "This agent page does not exist or is unpublished."}
          </div>
        </div>
      </div>
    );
  }

  const callHref = profile.phone ? `tel:${profile.phone.replace(/[^\d+]/g, "")}` : null;
  const mailHref = profile.email ? `mailto:${profile.email}` : null;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={`h-8 w-8 rounded-2xl ring-1 ring-white/10 grid place-items-center ${heroGradient}`}>
              <Shield className="h-4 w-4" />
            </div>
            <div className="text-sm font-semibold tracking-tight">{profile.full_name}</div>
          </div>
          <nav className="flex items-center gap-4 text-xs text-white/70">
            <a href="#overview" className="hover:text-white">Overview</a>
            <a href="#licenses" className="hover:text-white">Licenses</a>
            <a href="#contact" className="hover:text-white">Contact</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section id="overview" className="relative">
        <div className={`absolute inset-0 ${heroGradient} blur-3xl`} />
        <div className="relative mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-[220px_1fr]">
          <div className="flex items-start justify-center md:justify-start">
            <div className="relative h-40 w-40 overflow-hidden rounded-2xl border border-white/10 bg-white/5 ring-1 ring-white/10">
              {profile.headshot_url ? (
                <img src={profile.headshot_url} alt={profile.full_name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-white/50 text-xs">No photo</div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {/* Name, Broker, NPN, Phone */}
            <h1 className="text-3xl font-semibold tracking-tight">{profile.full_name}</h1>
            <div className="text-white/70">
              Licensed Broker {profile.npn ? <>· NPN: <span className="text-white">{profile.npn}</span></> : null}
            </div>
            {profile.phone && <div className="text-white/70">Phone: <span className="text-white">{profile.phone}</span></div>}

            {/* Bio */}
            {profile.short_bio && <p className="text-white/70 max-w-2xl">{profile.short_bio}</p>}

            {/* Contact Buttons */}
            <div className="flex flex-wrap gap-3 pt-2">
              {callHref && (
                <a href={callHref} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {mailHref && (
                <a href={mailHref} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Licenses */}
      <section id="licenses" className="mx-auto max-w-6xl px-4 pb-12">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Licensed States</h2>
          <div className="text-xs text-white/50">Documents are provided by the agent’s state(s).</div>
        </div>

        {states.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
            No licenses posted yet.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {states
              .slice()
              .sort((a, b) => a.state_code.localeCompare(b.state_code))
              .map((s) => {
                const code = s.state_code;
                const displayName = s.state_name || STATE_NAMES[code] || code;
                const url = s.licence_image_url || "";
                const isPdf = url.toLowerCase().endsWith(".pdf");
                const verifyHref = REGULATOR_LINKS[code];

                return (
                  <div key={code} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">
                        {displayName} <span className="text-white/50">({code})</span>
                      </div>
                      {verifyHref && (
                        <a
                          href={verifyHref}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-indigo-300 hover:underline inline-flex items-center gap-1"
                          title="Verify with the state"
                        >
                          Verify <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>

                    <div className="mt-2 text-xs text-white/70">
                      License #: <span className="text-white">{s.license_number || "—"}</span>
                    </div>

                    {url ? (
                      isPdf ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
                        >
                          View License PDF <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                          <img src={url} alt={`${code} license`} className="h-36 w-full object-cover" />
                          <div className="p-2 text-[11px] text-white/60">License image</div>
                        </div>
                      )
                    ) : (
                      <div className="mt-3 grid h-24 w-32 place-items-center rounded-lg border border-dashed border-white/15 text-xs text-white/50">
                        No document uploaded
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {/* Contact */}
      <section id="contact" className="border-t border-white/10 bg-black/40">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h3 className="text-base font-semibold">Contact</h3>
            <div className="mt-2 text-sm text-white/70">
              Have questions about coverage options or scheduling a call?
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              {callHref && (
                <a href={callHref} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {mailHref && (
                <a href={mailHref} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
            </div>
          </div>
          <div className="mt-6 text-center text-[11px] text-white/50">
            © {new Date().getFullYear()} Remie CRM — Agent page
          </div>
        </div>
      </section>
    </div>
  );
}
