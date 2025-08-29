// File: src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

// tiny helper
const nowIso = () => new Date().toISOString();
const slugify = (s = "") =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

export default function AgentShowcase() {
  const nav = useNavigate();

  // stepper
  const [step, setStep] = useState(1);

  // profile (step 1)
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [shortBio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");

  // headshot (step 2)
  const [headshotFile, setHeadshotFile] = useState(null);
  const [headshotUrl, setHeadshotUrl] = useState("");

  // states (step 3)
  const ALL_STATES = useMemo(
    () => [
      "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
      "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
      "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
      "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
      "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
    ],
    []
  );
  const [licensedStates, setLicensedStates] = useState([]);

  // publish (step 4)
  const [published, setPublished] = useState(false);
  const [publicSlug, setPublicSlug] = useState("");

  // load any existing profile for current user
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      const { data: prof, error } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", uid)
        .single();

      if (error || !prof) return;

      setFullName(prof.full_name || "");
      setEmail(prof.email || "");
      setPhone(prof.phone || "");
      setShortBio(prof.short_bio || "");
      setNpn(prof.npn || "");
      setHeadshotUrl(prof.headshot_url || "");
      setPublished(!!prof.published);
      setPublicSlug(prof.slug || "");

      // states
      const { data: states } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", uid);
      if (states?.length) {
        setLicensedStates(states.map((r) => r.state_code));
      }
    })();
  }, []);

  // ---------- Step 1: Save base profile ----------
  async function saveStep1() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      alert("Please log in again.");
      return;
    }

    if (!fullName) {
      alert("Please enter your full name.");
      return;
    }
    const slug = publicSlug || slugify(fullName);

    const row = {
      user_id: uid,
      slug,
      full_name: fullName,
      email: email || auth.user.email,
      phone,
      short_bio: shortBio,
      npn,
      // do not flip published here
      updated_at: nowIso(),
    };

    // If new user, set created_at
    const { data: exists } = await supabase
      .from("agent_profiles")
      .select("user_id")
      .eq("user_id", uid)
      .maybeSingle();

    if (!exists) row.created_at = nowIso();

    const { error } = await supabase.from("agent_profiles").upsert(row, {
      onConflict: "user_id",
    });

    if (error) {
      console.error(error);
      alert(`Save failed: ${error.message}`);
      return;
    }

    setPublicSlug(slug);
    setStep(2);
  }

  // ---------- Step 2: Upload headshot ----------
  async function uploadHeadshot(file) {
    if (!file) return;

    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      alert("Please log in again.");
      return;
    }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    // IMPORTANT: your folder is profile-pictures (plural)
    const key = `profile-pictures/${uid}/${Date.now()}.${ext}`;

    const bucket = supabase.storage.from("agent_public_v2");

    const { error: upErr } = await bucket.upload(key, file, {
      cacheControl: "3600",
      upsert: true,
      contentType: file.type || "image/jpeg",
    });
    if (upErr) {
      console.error(upErr);
      alert(`Headshot upload failed: ${upErr.message}`);
      return;
    }

    const { data: pub } = bucket.getPublicUrl(key);
    const url = pub?.publicUrl;
    setHeadshotUrl(url || "");

    // save URL to profile
    const { error: upsertErr } = await supabase
      .from("agent_profiles")
      .upsert(
        {
          user_id: uid,
          headshot_url: url,
          updated_at: nowIso(),
        },
        { onConflict: "user_id" }
      );
    if (upsertErr) {
      console.error(upsertErr);
      alert(`Failed to save headshot: ${upsertErr.message}`);
      return;
    }

    alert("Headshot uploaded.");
  }

  // ---------- Step 3: Save states ----------
  async function saveStates() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      alert("Please log in again.");
      return;
    }

    // wipe and reinsert for simplicity
    const { error: delErr } = await supabase
      .from("agent_states")
      .delete()
      .eq("user_id", uid);
    if (delErr) {
      console.error(delErr);
      alert(`Save failed: ${delErr.message}`);
      return;
    }

    if (licensedStates.length) {
      const rows = licensedStates.map((code) => ({
        user_id: uid,
        state_code: code,
      }));
      const { error: insErr } = await supabase.from("agent_states").insert(rows);
      if (insErr) {
        console.error(insErr);
        alert(`Save failed: ${insErr.message}`);
        return;
      }
    }

    setStep(4);
  }

  // ---------- Step 4: Publish ----------
  async function publishProfile() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      alert("Please log in again.");
      return;
    }

    const { error } = await supabase
      .from("agent_profiles")
      .upsert(
        {
          user_id: uid,
          published: true,
          updated_at: nowIso(),
        },
        { onConflict: "user_id" }
      );
    if (error) {
      console.error(error);
      alert(`Publish failed: ${error.message}`);
      return;
    }

    setPublished(true);
    alert("Published! Your public page is ready.");
  }

  const publicUrl = publicSlug
    ? `${window.location.origin}/agent/${publicSlug}`
    : "";

  return (
    <div className="max-w-3xl mx-auto p-4 text-white">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Agent Showcase</h1>
        <p className="text-white/70">
          Create your public “Agent Showcase” page in a few quick steps.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex gap-2 mb-6">
        {["Profile", "Headshot", "States", "Publish"].map((label, i) => {
          const n = i + 1;
          const active = step === n;
          const done = step > n;
          return (
            <div
              key={n}
              className={`rounded-full px-3 py-1 text-sm border ${
                active
                  ? "border-white/40 bg-white/10"
                  : done
                  ? "border-emerald-400/40 bg-emerald-400/10"
                  : "border-white/10"
              }`}
            >
              {n}. {label}
            </div>
          );
        })}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="text-sm block mb-1">Full name</label>
            <input
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="First Last"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm block mb-1">Email</label>
              <input
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
              />
            </div>
            <div>
              <label className="text-sm block mb-1">Phone</label>
              <input
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 555-5555"
              />
            </div>
          </div>

          <div>
            <label className="text-sm block mb-1">NPN</label>
            <input
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2"
              value={npn}
              onChange={(e) => setNpn(e.target.value)}
              placeholder="National Producer Number"
            />
          </div>

          <div>
            <label className="text-sm block mb-1">Short bio</label>
            <textarea
              rows={4}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2"
              value={shortBio}
              onChange={(e) => setShortBio(e.target.value)}
              placeholder="1–3 sentences about you and how you help families."
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={saveStep1}
              className="rounded-lg bg-white text-black px-4 py-2"
            >
              Save & Continue
            </button>
            {publicSlug && (
              <span className="text-xs text-white/60">
                Public URL (after publish):{" "}
                <code className="text-white/80">{publicUrl}</code>
              </span>
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-white/80">
            Upload a headshot. We’ll store it at{" "}
            <code>agent_public_v2/profile-pictures/&lt;uid&gt;/…</code>
          </p>

          {headshotUrl && (
            <img
              src={headshotUrl}
              alt="headshot"
              className="h-28 w-28 rounded-xl object-cover border border-white/10"
            />
          )}

          <input
            type="file"
            accept="image/*"
            onChange={(e) => uploadHeadshot(e.target.files?.[0] || null)}
          />

          <div className="flex items-center gap-2">
            <button
              onClick={() => setStep(1)}
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              className="rounded-lg bg-white text-black px-4 py-2"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <p className="text-white/80">
            Select the states where you’re licensed.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {ALL_STATES.map((code) => {
              const checked = licensedStates.includes(code);
              return (
                <label
                  key={code}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-sm ${
                    checked
                      ? "border-emerald-400/40 bg-emerald-400/10"
                      : "border-white/10"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setLicensedStates((s) => [...s, code]);
                      } else {
                        setLicensedStates((s) => s.filter((x) => x !== code));
                      }
                    }}
                  />
                  {code}
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setStep(2)}
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              Back
            </button>
            <button
              onClick={saveStates}
              className="rounded-lg bg-white text-black px-4 py-2"
            >
              Save & Continue
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <p className="text-white/80">
            Ready to go live? You can publish now, then share your page.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStep(3)}
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              Back
            </button>
            <button
              onClick={publishProfile}
              className="rounded-lg bg-white text-black px-4 py-2"
            >
              Publish
            </button>
            {published && publicSlug && (
              <Link
                to={`/agent/${publicSlug}`}
                target="_blank"
                className="rounded-lg border border-white/20 px-4 py-2"
              >
                View public page
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
