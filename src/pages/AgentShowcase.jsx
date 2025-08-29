// src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth";

// ---- State list (code -> name) ----
const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];
const STATE_NAME = Object.fromEntries(US_STATES.map(s => [s.code, s.name]));

// ---- Storage config (your bucket/folders) ----
const PUBLIC_BUCKET = "agent_public_v2";
const HEADSHOT_FOLDER = "profile-pictures";       // in agent_public_v2
const LICENSE_FOLDER = "licenses";                // in agent_private_v2 (if you want private) or public if you set so
// If licenses are private use: const PRIVATE_BUCKET = "agent_private_v2";

// Simple UI bits
const Section = ({ title, children }) => (
  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
    <div className="mb-3 text-sm font-semibold">{title}</div>
    {children}
  </div>
);

export default function AgentShowcase() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(1);

  // Step 1 profile
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [npn, setNpn] = useState("");
  const [shortBio, setShortBio] = useState("");

  // Step 2 headshot
  const [headshotUrl, setHeadshotUrl] = useState("");
  const [uploadingHeadshot, setUploadingHeadshot] = useState(false);

  // Step 3 licensing
  const [selectedStates, setSelectedStates] = useState([]);          // array of codes
  const [licenseNumbers, setLicenseNumbers] = useState({});          // { CA: "123", ... }
  const [licenseFiles, setLicenseFiles] = useState({});              // { CA: File, ... }
  const [licenseUrls, setLicenseUrls] = useState({});                // { CA: "public url or signed url", ... }
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    // Load profile + states (if any) so user can edit
    (async () => {
      const { data: prof } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (prof) {
        setFullName(prof.full_name || "");
        setEmail(prof.email || user.email || "");
        setPhone(prof.phone || "");
        setNpn(prof.npn || "");
        setShortBio(prof.short_bio || "");
        setHeadshotUrl(prof.headshot_url || "");
      }

      const { data: states } = await supabase
        .from("agent_states")
        .select("*")
        .eq("user_id", user.id);

      if (states?.length) {
        setSelectedStates(states.map(s => s.state_code));
        const nums = {};
        const urls = {};
        states.forEach(s => {
          if (s.license_number) nums[s.state_code] = s.license_number;
          if (s.license_image_url) urls[s.state_code] = s.license_image_url;
        });
        setLicenseNumbers(nums);
        setLicenseUrls(urls);
      }
    })();
  }, [user]);

  // ---------- Step 1: Save profile ----------
  async function saveProfileAndNext() {
    if (!user) return;
    setSaving(true);
    try {
      const slug = (fullName || user.email || user.id)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const row = {
        user_id: user.id,
        slug,
        full_name: fullName || null,
        email: email || user.email || null,
        phone: phone || null,
        npn: npn || null,
        short_bio: shortBio || null,
        headshot_url: headshotUrl || null,
        published: false,
      };

      const { error } = await supabase
        .from("agent_profiles")
        .upsert(row, { onConflict: "user_id" });

      if (error) throw error;

      setStep(2);
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // ---------- Step 2: Upload headshot ----------
  async function uploadHeadshot(file) {
    if (!user || !file) return;

    setUploadingHeadshot(true);
    try {
      const ext = file.name.split(".").pop();
      const path = `${HEADSHOT_FOLDER}/${user.id}.${ext}`;

      // upload to public bucket
      const { error: upErr } = await supabase.storage
        .from(PUBLIC_BUCKET)
        .upload(path, file, { upsert: true, cacheControl: "3600" });

      if (upErr) throw upErr;

      const { data: pub } = await supabase.storage
        .from(PUBLIC_BUCKET)
        .getPublicUrl(path);

      const publicUrl = pub?.publicUrl;
      setHeadshotUrl(publicUrl || "");

      // persist to profile
      await supabase.from("agent_profiles")
        .update({ headshot_url: publicUrl })
        .eq("user_id", user.id);

      alert("Headshot uploaded");
    } catch (e) {
      alert(`Headshot upload failed: ${e.message}`);
    } finally {
      setUploadingHeadshot(false);
    }
  }

  // ---------- Step 3: Save states + license files ----------
  async function saveStatesAndNext() {
    if (!user) return;
    setSaving(true);
    try {
      // 1) Upload any new/changed license files for selected states
      const newUrls = { ...licenseUrls };

      // Accept pdf/jpg/png
      const allowed = ["application/pdf", "image/jpeg", "image/png"];

      for (const code of selectedStates) {
        const f = licenseFiles[code];
        if (f) {
          if (!allowed.includes(f.type)) {
            throw new Error(`License for ${code} must be PDF or JPG/PNG`);
          }
          // Decide which bucket to use for licenses. If you created a PRIVATE bucket, replace PUBLIC_BUCKET
          const licPath = `${LICENSE_FOLDER}/${user.id}/${code}.${f.name.split(".").pop()}`;

          const { error: upErr } = await supabase.storage
            .from(PUBLIC_BUCKET) // or your private bucket if you set one and its RLS
            .upload(licPath, f, { upsert: true, cacheControl: "3600" });

          if (upErr) throw upErr;

          const { data: pub } = await supabase.storage
            .from(PUBLIC_BUCKET)
            .getPublicUrl(licPath);

          newUrls[code] = pub.publicUrl;
        }
      }

      setLicenseUrls(newUrls);

      // 2) Upsert rows (must include state_name to satisfy NOT NULL)
      const rows = selectedStates.map((code) => ({
        user_id: user.id,
        state_code: code,
        state_name: STATE_NAME[code] || null,             // <— IMPORTANT
        license_number: licenseNumbers[code] || null,
        license_image_url: newUrls[code] || null,
      }));

      const { error } = await supabase
        .from("agent_states")
        .upsert(rows, { onConflict: "user_id,state_code" }); // requires unique constraint in DB

      if (error) throw error;

      alert("States saved");
      setStep(4); // continue
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // ---- UI helpers ----
  function toggleState(code) {
    setSelectedStates((curr) =>
      curr.includes(code) ? curr.filter((c) => c !== code) : [...curr, code]
    );
  }

  const chosenStates = useMemo(
    () => US_STATES.filter((s) => selectedStates.includes(s.code)),
    [selectedStates]
  );

  if (!user) return <div className="p-6 text-white/80">Log in first.</div>;

  return (
    <div className="p-4 text-white">
      <div className="mb-4 text-xl font-semibold">Agent Showcase</div>

      {/* Step indicator */}
      <div className="mb-6 flex gap-2 text-xs">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`rounded-full px-2 py-1 ${
              step === i ? "bg-white text-black" : "bg-white/10 text-white/70"
            }`}
          >
            Step {i}
          </span>
        ))}
      </div>

      {step === 1 && (
        <Section title="Profile">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <div className="mb-1 text-white/70">Full name</div>
              <input className="w-full rounded-lg bg-white/5 p-2"
                     value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="mb-1 text-white/70">Email</div>
              <input className="w-full rounded-lg bg-white/5 p-2"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="mb-1 text-white/70">Phone</div>
              <input className="w-full rounded-lg bg-white/5 p-2"
                     value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="mb-1 text-white/70">NPN</div>
              <input className="w-full rounded-lg bg-white/5 p-2"
                     value={npn} onChange={(e) => setNpn(e.target.value)} />
            </label>
          </div>

          <label className="mt-4 block text-sm">
            <div className="mb-1 text-white/70">Short bio</div>
            <textarea className="w-full rounded-lg bg-white/5 p-2"
                      rows={5} value={shortBio}
                      onChange={(e) => setShortBio(e.target.value)} />
          </label>

          <div className="mt-4 flex gap-2">
            <button
              onClick={saveProfileAndNext}
              disabled={saving}
              className="rounded-lg bg-white px-4 py-2 text-black"
            >
              {saving ? "Saving..." : "Save & Next"}
            </button>
          </div>
        </Section>
      )}

      {step === 2 && (
        <Section title="Headshot">
          <div className="flex items-center gap-4">
            {headshotUrl ? (
              <img
                src={headshotUrl}
                alt="headshot"
                className="h-24 w-24 rounded-xl object-cover"
              />
            ) : (
              <div className="grid h-24 w-24 place-items-center rounded-xl bg-white/10 text-xs text-white/60">
                No photo
              </div>
            )}

            <label className="text-sm">
              <div className="mb-1 text-white/70">Upload (jpg/png)</div>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => uploadHeadshot(e.target.files?.[0])}
              />
            </label>
          </div>

          <div className="mt-4 flex gap-2">
            <button onClick={() => setStep(1)} className="rounded-lg border border-white/20 px-4 py-2">
              Back
            </button>
            <button onClick={() => setStep(3)} className="rounded-lg bg-white px-4 py-2 text-black">
              Next
            </button>
          </div>
        </Section>
      )}

      {step === 3 && (
        <Section title="Licensing">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {US_STATES.map((s) => (
              <button
                key={s.code}
                type="button"
                onClick={() => toggleState(s.code)}
                className={`rounded-md px-2 py-1 text-xs ${
                  selectedStates.includes(s.code)
                    ? "bg-white text-black"
                    : "bg-white/10 text-white/70"
                }`}
              >
                {s.code}
              </button>
            ))}
          </div>

          {chosenStates.length > 0 && (
            <div className="mt-5 space-y-4">
              {chosenStates.map((s) => (
                <div key={s.code} className="rounded-lg border border-white/10 p-3">
                  <div className="mb-2 text-sm font-medium">{s.name} ({s.code})</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-sm">
                      <div className="mb-1 text-white/70">License #</div>
                      <input
                        className="w-full rounded-lg bg-white/5 p-2"
                        value={licenseNumbers[s.code] || ""}
                        onChange={(e) =>
                          setLicenseNumbers((m) => ({ ...m, [s.code]: e.target.value }))
                        }
                      />
                    </label>
                    <label className="text-sm">
                      <div className="mb-1 text-white/70">Upload license (PDF/JPG/PNG)</div>
                      <input
                        type="file"
                        accept="application/pdf,image/*"
                        onChange={(e) =>
                          setLicenseFiles((m) => ({ ...m, [s.code]: e.target.files?.[0] }))
                        }
                      />
                      {licenseUrls[s.code] && (
                        <div className="mt-1 text-xs text-white/60">
                          Saved: <a className="underline" href={licenseUrls[s.code]} target="_blank" rel="noreferrer">view</a>
                        </div>
                      )}
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <button onClick={() => setStep(2)} className="rounded-lg border border-white/20 px-4 py-2">
              Back
            </button>
            <button
              onClick={saveStatesAndNext}
              disabled={saving}
              className="rounded-lg bg-white px-4 py-2 text-black"
            >
              {saving ? "Saving..." : "Save & Next"}
            </button>
          </div>
        </Section>
      )}

      {step === 4 && (
        <Section title="All set">
          <p className="text-white/80">
            Your Agent Showcase is saved. You can now publish or preview the public page.
          </p>
          <div className="mt-4 flex gap-2">
            <button onClick={() => nav("/app")} className="rounded-lg bg-white px-4 py-2 text-black">
              Finish
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
