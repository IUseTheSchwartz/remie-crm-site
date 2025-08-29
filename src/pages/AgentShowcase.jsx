// File: src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useNavigate } from "react-router-dom";

/* ---------- Helpers ---------- */
const STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/* ---------- Page ---------- */
export default function AgentShowcase() {
  const nav = useNavigate();

  // wizard step
  const [step, setStep] = useState(1);

  // profile form (Step 1)
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [shortBio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");
  const slug = useMemo(() => slugify(fullName) || "my-profile", [fullName]);

  // step 2
  const [headshotFile, setHeadshotFile] = useState(null);
  const [headshotUrl, setHeadshotUrl] = useState("");

  // step 3
  const [licensedStates, setLicensedStates] = useState([]);

  // step 4
  const [published, setPublished] = useState(false);

  const [loading, setLoading] = useState(false);
  const [savingStates, setSavingStates] = useState(false);

  /* ---------- Load existing ---------- */
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      // load profile
      const { data: prof, error: pe } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();
      if (!pe && prof) {
        setFullName(prof.full_name || "");
        setEmail(prof.email || auth.user.email || "");
        setPhone(prof.phone || "");
        setShortBio(prof.short_bio || "");
        setNpn(prof.npn || "");
        setPublished(!!prof.published);
        setHeadshotUrl(prof.headshot_url || "");
      } else {
        // prefill email from auth
        setEmail(auth.user?.email || "");
      }

      // load states
      const { data: st } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", uid);

      if (st?.length) setLicensedStates(st.map((r) => r.state_code));
    })();
  }, []);

  /* ---------- Step 1: Save profile ---------- */
  async function saveProfile() {
    setLoading(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      if (!fullName) throw new Error("Please enter your name");

      const now = new Date().toISOString();

      const { error } = await supabase.from("agent_profiles").upsert(
        {
          user_id: uid,
          slug,
          full_name: fullName,
          email,
          phone,
          short_bio: shortBio,
          npn,
          published, // keep whatever value you had
          headshot_url: headshotUrl || null,
          updated_at: now,
          // created_at will be defaulted by DB for new rows
        },
        { onConflict: "user_id" }
      );

      if (error) throw error;

      setStep(2);
    } catch (e) {
      console.error(e);
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  /* ---------- Step 2: Upload headshot ---------- */
  async function uploadHeadshot() {
    if (!headshotFile) {
      alert("Choose an image first");
      return;
    }
    setLoading(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      // IMPORTANT: your bucket/folder names
      const bucket = "agent_public_v2";
      const filePath = `profile-pictures/${uid}.jpg`;

      // upload (upsert true)
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(filePath, headshotFile, {
          upsert: true,
          contentType: headshotFile.type || "image/jpeg",
          cacheControl: "3600",
        });
      if (upErr) throw upErr;

      // we can use getPublicUrl (you set public read policy)
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(filePath);
      const publicUrl = pub?.publicUrl;
      if (!publicUrl) throw new Error("Could not get public URL");

      setHeadshotUrl(publicUrl);

      // persist URL to profile
      const { error: updErr } = await supabase
        .from("agent_profiles")
        .update({ headshot_url: publicUrl })
        .eq("user_id", uid);
      if (updErr) throw updErr;

      setStep(3);
    } catch (e) {
      console.error(e);
      alert(`Headshot upload failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  /* ---------- Step 3: Save states ---------- */
  function toggleState(code) {
    setLicensedStates((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  async function saveStates() {
    setSavingStates(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      // Clear any existing rows for this user
      const { error: delErr } = await supabase.from("agent_states").delete().eq("user_id", uid);
      if (delErr) throw delErr;

      // Insert current selections
      if (licensedStates.length) {
        const rows = licensedStates.map((code) => ({ user_id: uid, state_code: code }));
        const { error: insErr } = await supabase.from("agent_states").insert(rows);
        if (insErr) throw insErr;
      }

      setStep(4);
    } catch (e) {
      console.error(e);
      alert(`Save failed: ${e.message}`);
    } finally {
      setSavingStates(false);
    }
  }

  /* ---------- Step 4: Publish ---------- */
  const siteBase = `${window.location.origin}/a`;
  const publicUrl = `${siteBase}/${slug}`;

  async function setPublish(val) {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      const { error } = await supabase
        .from("agent_profiles")
        .update({ published: val })
        .eq("user_id", uid);
      if (error) throw error;

      setPublished(val);
      if (val) alert("Published! Your page is live.");
    } catch (e) {
      console.error(e);
      alert(e.message);
    }
  }

  /* ---------- Render ---------- */
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 text-white">
      <h1 className="text-2xl font-semibold">Agent Showcase</h1>
      <p className="mt-1 text-sm text-white/70">Create your public mini-site to share with clients.</p>

      <ol className="mt-6 grid grid-cols-4 gap-2 text-xs text-white/60">
        {[1, 2, 3, 4].map((s) => (
          <li
            key={s}
            className={`rounded-lg border px-3 py-2 text-center ${
              step === s ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.04]"
            }`}
          >
            Step {s}
          </li>
        ))}
      </ol>

      {/* STEP 1 */}
      {step === 1 && (
        <div className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full Name">
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                placeholder="First Last"
              />
            </Field>
            <Field label="Email">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                placeholder="you@email.com"
              />
            </Field>
            <Field label="Phone">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                placeholder="(555) 555-5555"
              />
            </Field>
            <Field label="NPN">
              <input
                value={npn}
                onChange={(e) => setNpn(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                placeholder="National Producer Number"
              />
            </Field>
            <Field label="Short Bio" full>
              <textarea
                value={shortBio}
                onChange={(e) => setShortBio(e.target.value)}
                className="min-h-[110px] w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                placeholder="One–two sentences about your practice…"
              />
            </Field>
          </div>

          <div className="mt-4 text-xs text-white/50">URL preview: /a/{slug}</div>

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              onClick={() => nav("/app")}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={saveProfile}
              disabled={loading}
              className={`rounded-lg bg-white px-4 py-2 text-sm font-medium text-black ${
                loading ? "opacity-50 cursor-not-allowed" : "hover:bg-neutral-200"
              }`}
            >
              {loading ? "Saving…" : "Save & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <div className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <Field label="Headshot">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setHeadshotFile(e.target.files?.[0] || null)}
              className="block text-sm"
            />
          </Field>

          {headshotUrl && (
            <img
              src={headshotUrl}
              alt="Headshot"
              className="mt-2 h-32 w-32 rounded-xl border border-white/10 object-cover"
            />
          )}

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              onClick={() => setStep(1)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Back
            </button>
            <button
              onClick={uploadHeadshot}
              disabled={loading}
              className={`rounded-lg bg-white px-4 py-2 text-sm font-medium text-black ${
                loading ? "opacity-50 cursor-not-allowed" : "hover:bg-neutral-200"
              }`}
            >
              {loading ? "Uploading…" : "Upload & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <div className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {STATES.map((s) => {
              const selected = licensedStates.includes(s.code);
              return (
                <button
                  key={s.code}
                  onClick={() => toggleState(s.code)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${
                    selected ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.04]"
                  }`}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 text-white/50">({s.code})</span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              onClick={() => setStep(2)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Back
            </button>
            <button
              onClick={saveStates}
              disabled={savingStates}
              className={`rounded-lg bg-white px-4 py-2 text-sm font-medium text-black ${
                savingStates ? "opacity-50 cursor-not-allowed" : "hover:bg-neutral-200"
              }`}
            >
              {savingStates ? "Saving…" : "Save & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 */}
      {step === 4 && (
        <div className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="space-y-2">
            <div className="text-sm">Public page:</div>
            <a href={publicUrl} target="_blank" rel="noreferrer" className="text-indigo-300 underline">
              {publicUrl}
            </a>
          </div>

          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={published}
                onChange={(e) => setPublish(e.target.checked)}
              />
              <span>Publish my page</span>
            </label>
          </div>

          <div className="mt-4 flex items-center justify-end">
            <button
              onClick={() => nav("/app")}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Small UI helpers ---------- */
function Field({ label, children, full }) {
  return (
    <label className={`block ${full ? "md:col-span-2" : ""}`}>
      <div className="mb-1 text-xs font-medium text-white/70">{label}</div>
      {children}
    </label>
  );
}
