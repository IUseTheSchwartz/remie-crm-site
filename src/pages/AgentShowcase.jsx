// File: src/pages/AgentShowcase.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import supabase from "../lib/supabaseClient"; // default export in your client
import { useAuth } from "../auth.jsx";

const PUBLIC_BUCKET = "agent_public_v2";

export default function AgentShowcase() {
  const { user } = useAuth();
  const nav = useNavigate();

  // wizard steps
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  // agent_profiles columns (exact names)
  const [full_name, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [short_bio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");
  const [slug, setSlug] = useState(""); // used for /agent/:slug
  const [headshot_url, setHeadshotUrl] = useState("");
  const [published, setPublished] = useState(false);

  useEffect(() => {
    if (!user) return;
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function loadProfile() {
    try {
      setLoading(true);
      // fetch the current user's profile row by user_id
      const { data, error } = await supabase
        .from("agent_profiles")
        .select("user_id, slug, full_name, email, phone, short_bio, npn, published, headshot_url")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setFullName(data.full_name ?? "");
        setEmail(data.email ?? user.email ?? "");
        setPhone(data.phone ?? "");
        setShortBio(data.short_bio ?? "");
        setNpn(data.npn ?? "");
        setSlug(data.slug ?? "");
        setHeadshotUrl(data.headshot_url ?? "");
        setPublished(!!data.published);
      } else {
        // first-time defaults
        setEmail(user.email ?? "");
      }
    } catch (e) {
      console.error("loadProfile error:", e);
    } finally {
      setLoading(false);
    }
  }

  async function uploadHeadshot(file) {
    if (!file || !user) return "";
    const ext = file.name.split(".").pop();
    const path = `profile-pictures/${user.id}-${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(PUBLIC_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) throw upErr;

    const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(path);
    return data?.publicUrl || "";
  }

  // STEP 1: save core fields (includes NPN)
  async function saveStep1() {
    if (!user) {
      alert("You must be signed in.");
      return;
    }
    if (!slug) {
      alert("Please set your public slug (ex: first-last).");
      return;
    }

    try {
      setLoading(true);

      // ensure slug is URL-safe
      const safeSlug = slug
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const payload = {
        user_id: user.id,          // REQUIRED by RLS
        slug: safeSlug,
        full_name,
        email,
        phone,
        short_bio,
        npn,
        headshot_url,
        published: false,          // only publish on Step 2
        updated_at: new Date().toISOString(),
      };

      // Upsert keyed by user_id so the user has exactly one row.
      // You should have a UNIQUE index on user_id for this to target properly.
      // SQL (run once): create unique index if not exists agent_profiles_user_id_key on public.agent_profiles(user_id);
      const { error } = await supabase
        .from("agent_profiles")
        .upsert(payload, { onConflict: "user_id" });

      if (error) throw error;

      setStep(2);
    } catch (e) {
      console.error("saveStep1 error:", e);
      alert(e.message || "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoading(true);
      const url = await uploadHeadshot(file);
      setHeadshotUrl(url);
    } catch (e) {
      console.error(e);
      alert("Failed to upload headshot");
    } finally {
      setLoading(false);
    }
  }

  // STEP 2: publish toggle
  async function savePublish(next) {
    if (!user) return;
    try {
      setLoading(true);
      const { error } = await supabase
        .from("agent_profiles")
        .update({ published: next, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      if (error) throw error;
      setPublished(next);
    } catch (e) {
      console.error(e);
      alert(e.message || "Failed to update publish status");
    } finally {
      setLoading(false);
    }
  }

  const publicUrl = slug ? `${window.location.origin}/agent/${slug}` : "";

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">Agent Showcase</h1>
        <p className="text-white/70">Fill your details and publish your public agent page.</p>

        <Steps step={step} />

        {step === 1 && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Full name">
                <input
                  value={full_name}
                  onChange={(e) => setFullName(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                  placeholder="Jane Agent"
                />
              </Field>
              <Field label="Public slug (for your URL)">
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                  placeholder="jane-agent"
                />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Email">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                  placeholder="you@email.com"
                />
              </Field>
              <Field label="Phone">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                  placeholder="(555) 555-5555"
                />
              </Field>
            </div>

            <Field label="NPN">
              <input
                value={npn}
                onChange={(e) => setNpn(e.target.value)}
                className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                placeholder="Your National Producer Number"
              />
            </Field>

            <Field label="Short bio">
              <textarea
                value={short_bio}
                onChange={(e) => setShortBio(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
                placeholder="A few lines about how you help families…"
              />
            </Field>

            <div>
              <div className="text-sm text-white/70">Headshot</div>
              <div className="mt-1 flex items-center gap-4">
                <input type="file" accept="image/*" onChange={handlePhotoChange} />
                {headshot_url ? (
                  <img
                    src={headshot_url}
                    alt="Headshot"
                    className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/10"
                  />
                ) : null}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={saveStep1}
                disabled={loading}
                className="rounded-lg bg-white/10 px-4 py-2 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-60"
              >
                {loading ? "Saving…" : "Save & Continue"}
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
            <h2 className="text-lg font-semibold">Publish</h2>
            <p className="text-white/70">
              Turn this on to make your public page visible at the URL below.
            </p>

            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={published}
                onChange={(e) => savePublish(e.target.checked)}
              />
              <span>Published</span>
            </label>

            <div className="text-sm">
              <div className="opacity-70 mb-1">Public URL:</div>
              <div className="break-all">
                {publicUrl ? (
                  <a className="underline text-indigo-300" href={publicUrl} target="_blank" rel="noreferrer">
                    {publicUrl}
                  </a>
                ) : (
                  <span className="opacity-60">Set your slug in Step 1 to see your URL</span>
                )}
              </div>
            </div>

            <div className="flex justify-between pt-2">
              <button
                onClick={() => setStep(1)}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={() => nav("/app")}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
              >
                Done
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Steps({ step }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Dot n={1} cur={step} label="Profile" />
      <div className="h-px w-10 bg-white/10" />
      <Dot n={2} cur={step} label="Publish" />
    </div>
  );
}
function Dot({ n, cur, label }) {
  const active = cur === n;
  const done = cur > n;
  return (
    <div className="flex items-center gap-2">
      <div
        className={`grid h-6 w-6 place-items-center rounded-full text-xs ${
          active ? "bg-white text-black" : done ? "bg-white/40 text-black" : "bg-white/10 text-white"
        }`}
      >
        {n}
      </div>
      <div className={`text-sm ${active ? "opacity-100" : "opacity-60"}`}>{label}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block text-sm">
      <div className="text-white/70">{label}</div>
      {children}
    </label>
  );
}
