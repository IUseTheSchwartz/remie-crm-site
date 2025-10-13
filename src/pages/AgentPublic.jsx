// File: src/pages/AgentPublic.jsx
import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";
import { ExternalLink, Phone, Mail, Shield, Star, X } from "lucide-react";

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

// ⭐ Reviews: helper to render large stars (solid or outline)
function StarDisplay({ rating = 0, size = "lg", variant = "auto" }) {
  const full = Math.floor(rating);
  const hasHalf = rating % 1 >= 0.5; // optional, not used visually here
  const empty = 5 - full - (hasHalf ? 1 : 0);

  const cls = {
    lg: "h-6 w-6",
    xl: "h-7 w-7",
  }[size] || "h-6 w-6";

  // if variant === "outline" force all outline; if "solid" force all solid; if "auto" follow rating
  const renderStar = (filled, i) => (
    <Star
      key={i}
      className={cls}
      style={filled ? { fill: "url(#star-grad)" } : {}}
      stroke={filled ? "none" : "url(#star-grad)"}
    />
  );

  const outlineSet = variant === "outline";
  const solidSet = variant === "solid";

  return (
    <div className="inline-flex items-center gap-1">
      <svg width="0" height="0">
        <defs>
          <linearGradient id="star-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="50%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#d946ef" />
          </linearGradient>
        </defs>
      </svg>
      {Array.from({ length: 5 }).map((_, i) => {
        if (outlineSet) return renderStar(false, i);
        if (solidSet) return renderStar(true, i);
        // auto
        return renderStar(i < full || (i === full && hasHalf), i);
      })}
    </div>
  );
}

// ⭐ Reviews: modal for public submissions (no captcha)
function LeaveReviewModal({ open, onClose, agentId, onSubmitted }) {
  const [rating, setRating] = useState(5);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!open) {
      setRating(5);
      setName("");
      setComment("");
      setBusy(false);
      setErr("");
      setOk(false);
    }
  }, [open]);

  async function submit() {
    if (!agentId || !rating) return;
    setBusy(true);
    setErr("");
    try {
      // Hitting Netlify function (uses service role) → inserts as is_public = false
      const res = await fetch("/.netlify/functions/leave-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          rating,
          reviewer_name: name || null,
          comment: comment || "",
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Failed to submit review.");
      setOk(true);
      onSubmitted?.();
      // leave the success message until they close
    } catch (e) {
      setErr(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-950 p-5 ring-1 ring-white/5">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Leave a Review</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-white/70 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {ok ? (
          <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            Thanks! Your review was submitted and will appear after approval.
          </div>
        ) : (
          <>
            {err && (
              <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                {err}
              </div>
            )}

            <div className="mt-4 space-y-4">
              <div>
                <div className="text-xs text-white/60 mb-1">Rating</div>
                <div className="inline-flex items-center gap-2">
                  <StarDisplay rating={rating} size="xl" variant="solid" />
                  <div className="inline-flex gap-1">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <button
                        key={i}
                        onClick={() => setRating(i)}
                        className={`rounded-md px-2 py-1 text-xs border ${
                          rating === i ? "border-white/20 bg-white/10" : "border-white/10 hover:bg-white/5"
                        }`}
                      >
                        {i}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs text-white/60 mb-1">Your name (optional)</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Maria R."
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              <div>
                <div className="text-xs text-white/60 mb-1">Comment (optional)</div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, 280))}
                  placeholder="Short feedback (max 280 chars)"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 min-h-[96px] resize-vertical"
                />
                <div className="mt-1 text-[11px] text-white/40">{comment.length}/280</div>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={onClose} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm font-medium
                           bg-gradient-to-r from-indigo-500 via-purple-500 to-fuchsia-500
                           ring-1 ring-white/10 hover:ring-white/20 disabled:opacity-60"
              >
                {busy ? "Submitting…" : "Submit Review"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ⭐ Reviews: public list + controls
  const [reviews, setReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);

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

        // Public states
        const { data: st, error: e2 } = await supabase
          .from("agent_states")
          .select("state_code, state_name, license_number, license_image_url")
          .eq("user_id", prof.user_id);

        if (!e2 && mounted) setStates(st || []);
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

    return () => { mounted = false; };
  }, [slug]);

  // ⭐ Reviews: fetch public reviews for this agent
  async function fetchReviews(agentId) {
    if (!agentId) return;
    setReviewsLoading(true);
    try {
      const { data, error } = await supabase
        .from("agent_reviews")
        .select("id, rating, reviewer_name, comment, created_at")
        .eq("agent_id", agentId)
        .eq("is_public", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setReviews(data || []);
    } catch (e) {
      console.warn("reviews fetch failed", e);
      setReviews([]);
    } finally {
      setReviewsLoading(false);
    }
  }

  useEffect(() => {
    if (profile?.user_id) fetchReviews(profile.user_id);
  }, [profile?.user_id]);

  const avg = useMemo(() => {
    if (!reviews.length) return 0;
    const total = reviews.reduce((s, r) => s + Number(r.rating || 0), 0);
    return Math.round((total / reviews.length) * 10) / 10;
  }, [reviews]);

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
  const bookHref = profile.calendly_url ? profile.calendly_url : null;

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
            <a href="#reviews" className="hover:text-white">Reviews</a> {/* ⭐ new anchor */}
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
            <h1 className="text-3xl font-semibold tracking-tight">{profile.full_name}</h1>
            <div className="text-white/70">
              Licensed Broker {profile.npn ? <>· NPN: <span className="text-white">{profile.npn}</span></> : null}
            </div>
            {profile.phone && <div className="text-white/70">Phone: <span className="text-white">{profile.phone}</span></div>}
            {profile.short_bio && <p className="text-white/70 max-w-2xl">{profile.short_bio}</p>}

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
              {bookHref && (
                <a href={bookHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10" title="Book an appointment">
                  <ExternalLink className="h-4 w-4" /> Book appointment
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Brokerage stats */}
      <section className="mx-auto max-w-6xl px-4 pb-10">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 ring-1 ring-white/5">
          <div className="text-center text-xs tracking-widest text-white/60 mb-4">OUR BROKERAGE</div>
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
          <img src="/carriers/carriers.png" alt="Our carriers" className="max-w-full h-auto" />
        </div>
      </section>

      {/* ⭐ REVIEWS — big, full-width block */}
      <section id="reviews" className="mx-auto max-w-6xl px-4 pb-12">
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] ring-1 ring-white/5 p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl sm:text-3xl font-semibold">Client Reviews</h2>
              <div className="mt-2 flex items-center gap-3">
                <StarDisplay
                  rating={reviews.length ? avg : 0}
                  size="xl"
                  variant={reviews.length ? "auto" : "outline"}
                />
                <div className="text-sm text-white/70">
                  {reviews.length ? (
                    <>
                      <span className="font-medium text-white">{avg}</span> / 5 • {reviews.length} review{reviews.length > 1 ? "s" : ""}
                    </>
                  ) : (
                    "No reviews yet"
                  )}
                </div>
              </div>
            </div>

            <button
              onClick={() => setLeaveOpen(true)}
              className="self-start rounded-2xl px-4 py-2 text-sm font-medium
                         bg-gradient-to-r from-indigo-500 via-purple-500 to-fuchsia-500
                         ring-1 ring-white/10 hover:ring-white/20"
            >
              Leave a review
            </button>
          </div>

          {/* List */}
          <div className="mt-6">
            {reviewsLoading ? (
              <div className="text-sm text-white/60">Loading reviews…</div>
            ) : reviews.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/60">
                No reviews yet — be the first to share your experience.
              </div>
            ) : (
              <ul className="grid gap-4 md:grid-cols-2">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="flex items-center justify-between">
                      <StarDisplay rating={r.rating} size="lg" variant="auto" />
                      <div className="text-[11px] text-white/50">{new Date(r.created_at).toLocaleDateString()}</div>
                    </div>
                    <div className="mt-2 text-sm font-medium">{r.reviewer_name || "Verified Client"}</div>
                    {r.comment && <p className="mt-1 text-sm text-white/80">{r.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
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
                const url = s.license_image_url || "";
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
              {profile.phone && (
                <a href={`tel:${profile.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {profile.email && (
                <a href={`mailto:${profile.email}`} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
              {profile.calendly_url && (
                <a href={profile.calendly_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
                  <ExternalLink className="h-4 w-4" /> Book appointment
                </a>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="mt-6 text-center text-[11px] text-white/50 space-y-2">
            <div>© {new Date().getFullYear()} Remie CRM — Agent page</div>
            <div className="space-x-3">
              <Link to="/legal/terms" className="hover:text-white">Terms of Service</Link>
              <span className="text-white/30">•</span>
              <Link to="/legal/privacy" className="hover:text-white">Privacy Policy</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ⭐ Leave Review Modal */}
      <LeaveReviewModal
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        agentId={profile.user_id}
        onSubmitted={() => fetchReviews(profile.user_id)}
      />
    </div>
  );
}
