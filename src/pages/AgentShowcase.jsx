import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import supabase from "../lib/supabaseClient";

// ---- Storage config (matches your buckets/folders) ----
const PUBLIC_BUCKET = "agent_public_v2";
const HEADSHOT_PREFIX = "profile-pictures";

// ---- States master list (full 50 + DC) ----
const ALL_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" }, { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" }, { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" }, { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" }, { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" }
];

function slugify(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Upload headshot to storage and return a public URL */
async function uploadHeadshot(file, userId) {
  if (!file || !userId) return "";

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${HEADSHOT_PREFIX}/${userId}-${Date.now()}.${ext}`;

  const bucket = supabase.storage.from(PUBLIC_BUCKET);

  const { error: upErr } = await bucket.upload(path, file, {
    upsert: true,
    contentType: file.type || "image/jpeg",
  });
  if (upErr) throw new Error(upErr.message || "Upload failed");

  const { data, error: urlErr } = bucket.getPublicUrl(path);
  if (urlErr) throw new Error(urlErr.message || "Failed to create public URL");

  return data?.publicUrl || "";
}

export default function AgentShowcase() {
  const nav = useNavigate();

  const [session, setSession] = useState(null);
  const user = session?.user || null;

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Profile form (Step 1)
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [shortBio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");
  const [slug, setSlug] = useState("");
  const [headshotUrl, setHeadshotUrl] = useState("");

  // States (Step 2)
  const [stateSearch, setStateSearch] = useState("");
  const [states, setStates] = useState([]); // list of codes

  // Publish (Step 3)
  const [published, setPublished] = useState(false);

  // load session
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session || null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // load existing profile + states for user
  useEffect(() => {
    if (!user) return;

    (async () => {
      const { data: prof, error: pe } = await supabase
        .from("agent_profiles")
        .select(
          "user_id, slug, full_name, email, phone, short_bio, npn, published, headshot_url"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (pe) {
        console.error(pe);
        alert(pe.message);
        return;
      }

      if (prof) {
        setFullName(prof.full_name || "");
        setEmail(prof.email || user.email || "");
        setPhone(prof.phone || "");
        setShortBio(prof.short_bio || "");
        setNpn(prof.npn || "");
        setSlug(prof.slug || slugify(prof.full_name || user.email || ""));
        setHeadshotUrl(prof.headshot_url || "");
        setPublished(!!prof.published);
      } else {
        // initialize slug/email defaults
        setEmail(user.email || "");
        const defaultSlug = slugify(user.email?.split("@")[0] || user.id);
        setSlug(defaultSlug);
      }

      const { data: sts, error: se } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", user.id);

      if (!se && sts) {
        setStates(sts.map((r) => r.state_code));
      }
    })();
  }, [user]);

  const filteredStates = useMemo(() => {
    const q = stateSearch.trim().toLowerCase();
    if (!q) return ALL_STATES;
    return ALL_STATES.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
    );
  }, [stateSearch]);

  async function saveStep1(e) {
    e?.preventDefault?.();
    if (!user) return alert("You must be logged in.");

    if (!fullName) return alert("Please enter your full name.");
    if (!email) return alert("Please enter your email.");
    if (!npn) return alert("Please enter your NPN.");

    setSaving(true);
    try {
      const payload = {
        user_id: user.id,
        slug: slug || slugify(fullName),
        full_name: fullName,
        email,
        phone,
        short_bio: shortBio,
        npn,
        headshot_url: headshotUrl || null,
        published, // keep current
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("agent_profiles")
        .upsert(payload, { onConflict: "user_id" });

      if (error) throw error;
      setStep(2);
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function onPickHeadshot(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setSaving(true);
      const url = await uploadHeadshot(file, user.id);
      setHeadshotUrl(url);
    } catch (err) {
      console.error(err);
      alert(`Failed to upload headshot: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveStates(e) {
    e?.preventDefault?.();
    if (!user) return;

    setSaving(true);
    try {
      // replace rows for this user
      const rows = states.map((c) => ({ user_id: user.id, state_code: c }));
      // delete old
      await supabase.from("agent_states").delete().eq("user_id", user.id);
      if (rows.length) {
        const { error } = await supabase.from("agent_states").insert(rows);
        if (error) throw error;
      }
      setStep(3);
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to save states.");
    } finally {
      setSaving(false);
    }
  }

  async function publishProfile(e) {
    e?.preventDefault?.();
    if (!user) return;

    setSaving(true);
    try {
      // sanity defaults
      const finalSlug = slug || slugify(fullName || email);

      const { error } = await supabase
        .from("agent_profiles")
        .update({
          slug: finalSlug,
          published: true,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);

      if (error) throw error;
      setPublished(true);
      // route to public page
      nav(`/agent/${finalSlug}`);
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to publish.");
    } finally {
      setSaving(false);
    }
  }

  if (!session) {
    return (
      <div className="p-6 text-white">
        <h1 className="text-xl font-semibold mb-3">Agent Showcase</h1>
        <p>Please log in to continue.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 text-white">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Agent Showcase</h1>
        {published && slug && (
          <Link
            className="text-sm underline opacity-80 hover:opacity-100"
            to={`/agent/${slug}`}
          >
            View public page
          </Link>
        )}
      </div>

      {/* Steps indicator */}
      <div className="flex gap-2 mb-6">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className={`h-2 w-16 rounded-full ${
              step >= n ? "bg-indigo-500" : "bg-white/20"
            }`}
          />
        ))}
      </div>

      {/* STEP 1 – Profile */}
      {step === 1 && (
        <form onSubmit={saveStep1} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm mb-1">Full Name</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  if (!slug) setSlug(slugify(e.target.value));
                }}
                placeholder="Jane Agent"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Email</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Phone</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 555-5555"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">NPN</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={npn}
                onChange={(e) => setNpn(e.target.value)}
                placeholder="National Producer Number"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm mb-1">Short Bio</label>
            <textarea
              rows={4}
              className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
              value={shortBio}
              onChange={(e) => setShortBio(e.target.value)}
              placeholder="Tell your clients who you are and how you help."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_auto] items-end">
            <div>
              <label className="block text-sm mb-1">Public URL slug</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value))}
                placeholder="your-name"
              />
              <p className="text-xs opacity-70 mt-1">
                Preview: <code>/agent/{slug || "your-name"}</code>
              </p>
            </div>
            <div>
              <label className="block text-sm mb-1">Headshot</label>
              <input type="file" accept="image/*" onChange={onPickHeadshot} />
              {headshotUrl && (
                <img
                  src={headshotUrl}
                  alt="headshot"
                  className="mt-2 h-24 w-24 object-cover rounded-lg border border-white/10"
                />
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              disabled={saving}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save & Next"}
            </button>
          </div>
        </form>
      )}

      {/* STEP 2 – Licensed states */}
      {step === 2 && (
        <form onSubmit={saveStates} className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <div className="flex-1">
              <label className="block text-sm mb-1">Search states</label>
              <input
                className="w-full rounded-lg bg-white/5 px-3 py-2 border border-white/10"
                value={stateSearch}
                onChange={(e) => setStateSearch(e.target.value)}
                placeholder="Search by code or name…"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStates(ALL_STATES.map((s) => s.code))}
                className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setStates([])}
                className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[420px] overflow-auto p-2 rounded-lg bg-white/[0.03] border border-white/10">
            {filteredStates.map((s) => {
              const checked = states.includes(s.code);
              return (
                <label
                  key={s.code}
                  className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-white/5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setStates((cur) =>
                        e.target.checked
                          ? [...new Set([...cur, s.code])]
                          : cur.filter((c) => c !== s.code)
                      );
                    }}
                  />
                  <span className="tabular-nums w-10">{s.code}</span>
                  <span className="opacity-80">{s.name}</span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Back
            </button>
            <button
              disabled={saving}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save & Next"}
            </button>
          </div>
        </form>
      )}

      {/* STEP 3 – Publish */}
      {step === 3 && (
        <form onSubmit={publishProfile} className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h3 className="font-semibold mb-2">Publish your page</h3>
            <p className="text-sm opacity-80">
              When you publish, your page will be live at{" "}
              <code className="text-indigo-300">/agent/{slug || "your-name"}</code>.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Back
            </button>
            <button
              disabled={saving}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Publishing…" : "Publish"}
            </button>
            {published && slug && (
              <Link
                className="text-sm underline opacity-80 hover:opacity-100"
                to={`/agent/${slug}`}
              >
                View public page
              </Link>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
