// File: src/pages/AgentPublic.jsx
import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";
import { ExternalLink, Phone, Mail, Shield, Star } from "lucide-react";

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

const BROKERAGE_STATS = [
  { value: "1 MILLION+", label: "Families Helped" },
  { value: "$150 BILLION", label: "Life Insurance In Place" },
  { value: "$800 MILLION", label: "Premium Sold Per Year" },
  { value: "29,000+", label: "Professional Agents" },
];

/* ----------------------------- Reviews UI -------------------------------- */

function GradientStarOutline({ className = "h-5 w-5" }) {
  // Outlined star with gradient stroke (empty state)
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <defs>
        <linearGradient id="star-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" /> {/* indigo-500 */}
          <stop offset="50%" stopColor="#a855f7" /> {/* purple-500 */}
          <stop offset="100%" stopColor="#ec4899" /> {/* fuchsia/rose-ish */}
        </linearGradient>
      </defs>
      <path
        d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"
        fill="none"
        stroke="url(#star-stroke)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GradientStarFilled({ percent = 100, className = "h-5 w-5" }) {
  // Filled star with gradient; supports partial fill via clipped overlay
  return (
    <div className="relative inline-block" style={{ width: "1.25rem", height: "1.25rem" }}>
      {/* Base outline for crisp edges */}
      <GradientStarOutline className={className + " absolute inset-0"} />
      {/* Fill overlay clipped to percent */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${percent}%` }}
      >
        <svg viewBox="0 0 24 24" className={className}>
          <defs>
            <linearGradient id="star-fill" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6366f1" />
              <stop offset="50%" stopColor="#a855f7" />
              <stop offset="100%" stopColor="#ec4899" />
            </linearGradient>
          </defs>
          <path
            d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"
            fill="url(#star-fill)"
            stroke="none"
          />
        </svg>
      </div>
    </div>
  );
}

function StarRow({ value, size = "md" }) {
  // value can be fractional (e.g., 4.3)
  const sizeMap = { sm: "h-4 w-4", md: "h-5 w-5", lg: "h-6 w-6" };
  const cls = sizeMap[size] || sizeMap.md;
  const full = Math.floor(value);
  const frac = value - full;
  const pct = Math.round(frac * 100);

  return (
    <div className="inline-flex items-center gap-1">
      {Array.from({ length: 5 }).map((_, i) => {
        if (i < full) return <GradientStarFilled key={i} percent={100} className={cls} />;
        if (i === full && pct > 0) return <GradientStarFilled key={i} percent={pct} className={cls} />;
        return <GradientStarOutline key={i} className={cls} />;
      })}
    </div>
  );
}

function ReviewsBlock({ agentId }) {
  const [reviews, setReviews] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const { data, error } = await supabase
          .from("agent_reviews")
          .select("id, rating, comment, reviewer_name, created_at, is_public")
          .eq("agent_id", agentId)
          .eq("is_public", true)
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (on) setReviews(data || []);
      } catch (e) {
        console.warn("agent_reviews fetch failed:", e?.message || e);
        if (on) setErr("Reviews are unavailable right now.");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => { on = false; };
  }, [agentId]);

  const { avg, count } = useMemo(() => {
    if (!reviews.length) return { avg: 0, count: 0 };
    const sum = reviews.reduce((acc, r) => acc + Number(r.rating || 0), 0);
    const avg = Math.max(0, Math.min(5, sum / reviews.length));
    return { avg, count: reviews.length };
  }, [reviews]);

  return (
    <section className="mt-5">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center rounded-xl border border-white/10 bg-white/5">
              <Star className="h-4 w-4 text-white/80" />
            </div>
            <div>
              <div className="text-sm font-medium">Client Reviews</div>
              <div className="text-xs text-white/60">
                {loading ? "Loading…" : count ? `${count} review${count > 1 ? "s" : ""}` : "No reviews yet"}
              </div>
            </div>
          </div>

          {/* Average stars */}
          <div className="flex items-center gap-2">
            {count ? (
              <>
                <StarRow value={avg} />
                <span className="text-sm text-white/80">{avg.toFixed(1)}/5</span>
              </>
            ) : (
              <div className="flex items-center gap-2">
                {/* Empty state: outlined stars only */}
                <div className="inline-flex items-center gap-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <GradientStarOutline key={i} />
                  ))}
                </div>
                <span className="text-sm text-white/60">No reviews yet</span>
              </div>
            )}
          </div>
        </div>

        {/* Recent reviews */}
        {err ? (
          <div className="mt-3 text-xs text-rose-300">{err}</div>
        ) : (
          count > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {reviews.slice(0, 3).map((r) => (
                <div
                  key={r.id}
                  className="rounded-xl border border-white/10 bg-black/30 p-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium truncate">
                      {r.reviewer_name || "Anonymous"}
                    </div>
                    <StarRow value={Math.max(1, Math.min(5, Number(r.rating || 0)))} size="sm" />
                  </div>
                  {r.comment && (
                    <p className="mt-2 text-sm text-white/80 line-clamp-5">{r.comment}</p>
                  )}
                  <div className="mt-2 text-[11px] text-white/50">
                    {new Date(r.created_at).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const heroGradient =
    "bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10";

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setLoadError("");

      try {
        // ✅ Public profile by slug AND must be published
        const { data: prof, error: e1 } = await supabase
          .from("agent_profiles")
          .select(
            "user_id, full_name, email, phone, short_bio, headshot_url, npn, published, slug, calendly_url"
          )
          .eq("slug", slug)
          .eq("published", true)
          .maybeSingle();

        if (e1) throw e1;
        if (!prof) {
          if (mounted) {
            setProfile(null);
            setStates([]);
          }
          return;
        }

        if (mounted) setProfile(prof);

        // Public states for that agent (RLS should allow if profile is published)
        const { data: st, error: e2 } = await supabase
          .from("agent_states")
          .select(
            "state_code, state_name, license_number, license_image_url"
          )
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

  const callHref = profile.phone
    ? `tel:${profile.phone.replace(/[^\d+]/g, "")}`
    : null;
  const mailHref = profile.email ? `mailto:${profile.email}` : null;
  const bookHref = profile.calendly_url ? profile.calendly_url : null;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div
              className={`h-8 w-8 rounded-2xl ring-1 ring-white/10 grid place-items-center ${heroGradient}`}
            >
              <Shield className="h-4 w-4" />
            </div>
            <div className="text-sm font-semibold tracking-tight">
              {profile.full_name}
            </div>
          </div>
          <nav className="flex items-center gap-4 text-xs text-white/70">
            <a href="#overview" className="hover:text-white">
              Overview
            </a>
            <a href="#licenses" className="hover:text-white">
              Licenses
            </a>
            <a href="#contact" className="hover:text-white">
              Contact
            </a>
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
                <img
                  src={profile.headshot_url}
                  alt={profile.full_name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-white/50 text-xs">
                  No photo
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {profile.full_name}
            </h1>
            <div className="text-white/70">
              Licensed Broker{" "}
              {profile.npn ? (
                <>
                  · NPN: <span className="text-white">{profile.npn}</span>
                </>
              ) : null}
            </div>
            {profile.phone && (
              <div className="text-white/70">
                Phone: <span className="text-white">{profile.phone}</span>
              </div>
            )}
            {profile.short_bio && (
              <p className="text-white/70 max-w-2xl">{profile.short_bio}</p>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              {callHref && (
                <a
                  href={callHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {mailHref && (
                <a
                  href={mailHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
              {bookHref && (
                <a
                  href={bookHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                  title="Book an appointment"
                >
                  <ExternalLink className="h-4 w-4" /> Book appointment
                </a>
              )}
            </div>

            {/* ⭐ Reviews block lives directly under the CTAs */}
            <ReviewsBlock agentId={profile.user_id} />
          </div>
        </div>
      </section>

      {/* Brokerage stats */}
      <section className="mx-auto max-w-6xl px-4 pb-10">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 ring-1 ring-white/5">
          <div className="text-center text-xs tracking-widest text-white/60 mb-4">
            OUR BROKERAGE
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {BROKERAGE_STATS.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-rose-400 bg-clip-text text-transparent">
                  {s.value}
                </div>
                <div className="mt-1 text-sm text-white/70">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Carrier logos (single image) */}
      <section className="mx-auto max-w-6xl px-4 pb-12">
        <h2 className="text-center text-xl font-semibold">
          As a broker, we shop multiple A-rated carriers to find your best fit.
        </h2>
        <div className="mt-6 flex justify-center">
          <img
            src="/carriers/carriers.png"
            alt="Our carriers"
            className="max-w-full h-auto"
          />
        </div>
      </section>

      {/* Licenses */}
      <section id="licenses" className="mx-auto max-w-6xl px-4 pb-12">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Licensed States</h2>
          <div className="text-xs text-white/50">
            Documents are provided by the agent’s state(s).
          </div>
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
                const url = s.license_image_url || "";
                const isPdf = url.toLowerCase().endsWith(".pdf");
                const verifyHref = REGULATOR_LINKS[code];

                return (
                  <div
                    key={code}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">
                        {displayName}{" "}
                        <span className="text-white/50">({code})</span>
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
                      License #:{" "}
                      <span className="text-white">
                        {s.license_number || "—"}
                      </span>
                    </div>

                    {url ? (
                      isPdf ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
                        >
                          View License PDF{" "}
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                          <img
                            src={url}
                            alt={`${code} license`}
                            className="h-36 w-full object-cover"
                          />
                          <div className="p-2 text-[11px] text-white/60">
                            License image
                          </div>
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
              {profile.phone && (
                <a
                  href={`tel:${profile.phone.replace(/[^\d+]/g, "")}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {profile.email && (
                <a
                  href={`mailto:${profile.email}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
              {profile.calendly_url && (
                <a
                  href={profile.calendly_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <ExternalLink className="h-4 w-4" /> Book appointment
                </a>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="mt-6 text-center text-[11px] text-white/50 space-y-2">
            <div>© {new Date().getFullYear()} Remie CRM — Agent page</div>
            <div className="space-x-3">
              <Link to="/legal/terms" className="hover:text-white">
                Terms of Service
              </Link>
              <span className="text-white/30">•</span>
              <Link to="/legal/privacy" className="hover:text-white">
                Privacy Policy
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
