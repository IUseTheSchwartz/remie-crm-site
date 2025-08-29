// File: src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// ===== configure your bucket names here =====
const PUBLIC_BUCKET  = "agent_public_v2";   // public files (headshot, public site assets)
const PRIVATE_BUCKET = "agent_private_v2";  // private files (license images, docs)

// simple list used for the "licensed states" UI
const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

export default function AgentShowcase() {
  const [step, setStep] = useState(1);

  // profile (step 1)
  const [fullName, setFullName] = useState("");
  const [email, setEmail]       = useState("");
  const [phone, setPhone]       = useState("");
  const [bio, setBio]           = useState("");
  const [headshotUrl, setHeadshotUrl] = useState("");
  const [saving1, setSaving1] = useState(false);

  // states (step 2)
  const [licensedStates, setLicensedStates] = useState([]); // array of "TX","CA" etc.
  const [licenseFile, setLicenseFile] = useState(null);
  const [licenseUploading, setLicenseUploading] = useState(false);
  const [saving2, setSaving2] = useState(false);

  // publish (step 3)
  const [published, setPublished] = useState(false);
  const [saving3, setSaving3] = useState(false);

  const showcaseUrl = useMemo(() => {
    // You can change this to your public route for agent profiles if you have one.
    // Example: /a/:username or /agent/:id — for now we just show a placeholder.
    return headshotUrl ? headshotUrl : "";
  }, [headshotUrl]);

  // ===== helpers =====

  async function getUser() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error("You must be signed in");
    return data.user;
  }

  // load existing profile data (Step 1), states (Step 2), and publish flag
  useEffect(() => {
    (async () => {
      try {
        const user = await getUser();

        // load profile row
        const { data: prof, error: pErr } = await supabase
          .from("agent_profiles")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (pErr) console.error(pErr);

        if (prof) {
          setFullName(prof.full_name || "");
          setEmail(prof.email || "");
          setPhone(prof.phone || "");
          setBio(prof.bio || "");
          setHeadshotUrl(prof.headshot_url || "");
          setPublished(!!prof.published);
        }

        // load states
        const { data: states, error: sErr } = await supabase
          .from("agent_states")
          .select("state_code")
          .eq("user_id", user.id);

        if (!sErr && states?.length) {
          setLicensedStates(states.map((r) => r.state_code));
        }
      } catch (e) {
        console.error("load error", e);
      }
    })();
  }, []);

  // upload a file to a bucket & return the public URL (for public bucket)
  async function uploadToPublic(file, prefix = "profile-pictures") {
    if (!file) return null;
    const user = await getUser();

    const ext = file.name.split(".").pop();
    const path = `${prefix}/${user.id}-${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(PUBLIC_BUCKET)
      .upload(path, file, { upsert: true });

    if (upErr) throw upErr;

    const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  // upload to private bucket (returns the storage path, NOT a public url)
  async function uploadToPrivate(file, prefix = "licenses") {
    if (!file) return null;
    const user = await getUser();

    const ext = file.name.split(".").pop();
    const path = `${prefix}/${user.id}-${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .upload(path, file, { upsert: true });

    if (upErr) throw upErr;
    return path; // keep path; access via signed URL or server if needed
  }

  // ===== Step 1: save profile with user_id (RLS requirement) =====
  async function handleSaveStep1() {
    setSaving1(true);
    try {
      const user = await getUser();

      // upsert agent_profiles row; user_id is required by RLS!
      const { error } = await supabase
        .from("agent_profiles")
        .upsert(
          {
            user_id: user.id,
            full_name: fullName,
            email,
            phone,
            bio,
            headshot_url: headshotUrl || null,
            published: false, // do not publish until step 3
          },
          { onConflict: "user_id" } // requires a unique index on user_id (see instructions)
        );

      if (error) throw error;

      setStep(2);
    } catch (e) {
      console.error("Step 1 save error:", e);
      alert(e?.message || "Failed to save profile");
    } finally {
      setSaving1(false);
    }
  }

  // ===== Step 2: save licensed states + optional license upload =====
  async function handleSaveStep2() {
    setSaving2(true);
    try {
      const user = await getUser();

      // OPTIONAL upload license / doc to private bucket
      if (licenseFile) {
        setLicenseUploading(true);
        const storagePath = await uploadToPrivate(licenseFile, "licenses");
        setLicenseUploading(false);

        // store a row in agent_documents to track the uploaded license
        const { error: dErr } = await supabase
          .from("agent_documents")
          .insert({
            user_id: user.id,
            doc_type: "license",
            storage_path: storagePath,
          });
        if (dErr) throw dErr;
      }

      // replace existing states with the selected list
      // delete existing
      const { error: delErr } = await supabase
        .from("agent_states")
        .delete()
        .eq("user_id", user.id);
      if (delErr) throw delErr;

      // insert new
      if (licensedStates.length) {
        const rows = licensedStates.map((sc) => ({
          user_id: user.id,
          state_code: sc,
        }));
        const { error: insErr } = await supabase.from("agent_states").insert(rows);
        if (insErr) throw insErr;
      }

      setStep(3);
    } catch (e) {
      console.error("Step 2 save error:", e);
      alert(e?.message || "Failed to save licensed states");
    } finally {
      setSaving2(false);
    }
  }

  // ===== Step 3: publish toggle =====
  async function handlePublishToggle(next) {
    setSaving3(true);
    try {
      const user = await getUser();
      const { error } = await supabase
        .from("agent_profiles")
        .update({ published: next })
        .eq("user_id", user.id);
      if (error) throw error;

      setPublished(next);
    } catch (e) {
      console.error("Publish error:", e);
      alert(e?.message || "Failed to update publish status");
    } finally {
      setSaving3(false);
    }
  }

  // ===== UI helpers =====

  function StateChip({ code }) {
    const active = licensedStates.includes(code);
    return (
      <button
        type="button"
        onClick={() =>
          setLicensedStates((cur) =>
            cur.includes(code) ? cur.filter((x) => x !== code) : [...cur, code]
          )
        }
        className={`px-3 py-1 rounded-full border text-xs mr-2 mb-2 ${
          active ? "bg-white/10 border-white/30" : "bg-transparent border-white/15"
        }`}
      >
        {code}
      </button>
    );
  }

  // ===== view =====
  return (
    <div className="min-h-screen bg-neutral-950 text-white p-4">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="text-sm opacity-70">Step</div>
          <StepDot n={1} cur={step} label="Profile" />
          <StepDot n={2} cur={step} label="States & License" />
          <StepDot n={3} cur={step} label="Publish" />
        </div>

        {step === 1 && (
          <section className="rounded-2xl border border-white/10 p-4">
            <h2 className="text-lg font-semibold mb-4">Agent Profile</h2>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm">
                Agent Name
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-white/5 px-3 py-2 outline-none ring-1 ring-white/10"
                  placeholder="Jane Agent"
                />
              </label>

              <label className="text-sm">
                Email
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-white/5 px-3 py-2 outline-none ring-1 ring-white/10"
                  placeholder="agent@email.com"
                />
              </label>

              <label className="text-sm">
                Phone
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-white/5 px-3 py-2 outline-none ring-1 ring-white/10"
                  placeholder="(555) 555-5555"
                />
              </label>

              <label className="text-sm md:col-span-2">
                Short Bio
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={4}
                  className="mt-1 w-full rounded-lg bg-white/5 px-3 py-2 outline-none ring-1 ring-white/10"
                  placeholder="A few lines about you, your experience, and how you help clients."
                />
              </label>

              <div className="md:col-span-2">
                <div className="text-sm mb-2">Headshot</div>
                {headshotUrl ? (
                  <div className="flex items-center gap-4">
                    <img
                      src={headshotUrl}
                      alt="headshot"
                      className="h-20 w-20 rounded-lg object-cover border border-white/10"
                      onError={() => setHeadshotUrl("")}
                    />
                    <button
                      className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
                      onClick={() => setHeadshotUrl("")}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const url = await uploadToPublic(f, "profile-pictures");
                        setHeadshotUrl(url);
                      } catch (err) {
                        console.error(err);
                        alert("Failed to upload headshot");
                      }
                    }}
                    className="block"
                  />
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveStep1}
                disabled={saving1}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                {saving1 ? "Saving…" : "Next"}
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="rounded-2xl border border-white/10 p-4">
            <h2 className="text-lg font-semibold mb-2">Licensed States & License</h2>
            <p className="text-sm text-white/70 mb-3">
              Select all states you’re licensed in. Optionally upload your license image (kept private).
            </p>

            <div className="mb-4">
              {US_STATES.map((code) => (
                <StateChip key={code} code={code} />
              ))}
            </div>

            <div className="mt-4">
              <div className="text-sm mb-1">Upload License (private)</div>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setLicenseFile(e.target.files?.[0] || null)}
              />
              {licenseUploading && <div className="text-xs mt-1 opacity-70">Uploading…</div>}
            </div>

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={handleSaveStep2}
                disabled={saving2}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                {saving2 ? "Saving…" : "Next"}
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="rounded-2xl border border-white/10 p-4">
            <h2 className="text-lg font-semibold mb-2">Publish</h2>
            <p className="text-sm text-white/70">
              Turn this on to make your public Agent Showcase page visible.
            </p>

            <div className="mt-4 flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={published}
                  onChange={(e) => handlePublishToggle(e.target.checked)}
                />
                <span>Published</span>
              </label>
              {saving3 && <span className="text-xs opacity-70">Saving…</span>}
            </div>

            {published && (
              <div className="mt-4 text-sm">
                <div className="opacity-70 mb-1">Preview (headshot URL for now):</div>
                <a
                  href={showcaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-indigo-300 break-all"
                >
                  {showcaseUrl || "(no headshot uploaded yet)"}
                </a>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(2)}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={() => alert("All set!")}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
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

function StepDot({ n, cur, label }) {
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
      {n < 3 && <div className="mx-3 h-px w-10 bg-white/10" />}
    </div>
  );
}
