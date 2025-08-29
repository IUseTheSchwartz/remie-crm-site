// File: src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth.jsx";
import { motion } from "framer-motion";

// ---------- STATE LIST & NAME MAP ----------
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

// ---------- UTIL ----------
const slugify = (s) =>
  (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

// ---------- PAGE ----------
export default function AgentShowcase() {
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Step 1 (agent_profiles)
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [shortBio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");
  const [headshotUrl, setHeadshotUrl] = useState("");

  // Step 2 (upload headshot)
  const [headshotFile, setHeadshotFile] = useState(null);

  // Step 3 (states & licenses)
  const [selectedStates, setSelectedStates] = useState([]);           // ['CA','AZ']
  const [licenseNumbers, setLicenseNumbers] = useState({});           // { CA:'123', AZ:'...' }
  const [licenseFiles, setLicenseFiles] = useState({});               // { CA:File, AZ:File }
  const [licenseUrls, setLicenseUrls] = useState({});                 // { CA:'https...', AZ:'...' }

  // prefill email from session
  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user]);

  // load existing profile + states
  useEffect(() => {
    (async () => {
      if (!user) return;

      // agent_profiles
      const { data: prof } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (prof) {
        setFullName(prof.full_name || "");
        setEmail(prof.email || user.email || "");
        setPhone(prof.phone || "");
        setShortBio(prof.short_bio || "");
        setNpn(prof.npn || "");
        setHeadshotUrl(prof.headshot_url || "");
      }

      // agent_states
      const { data: states } = await supabase
        .from("agent_states")
        .select("state_code, state_name, license_number, license_image_url")
        .eq("user_id", user.id);

      if (states?.length) {
        const codes = states.map(s => s.state_code);
        setSelectedStates(codes);
        const nums = {};
        const urls = {};
        states.forEach(s => {
          nums[s.state_code] = s.license_number || "";
          urls[s.state_code] = s.license_image_url || "";
        });
        setLicenseNumbers(nums);
        setLicenseUrls(urls);
      }
    })();
  }, [user]);

  const canNext1 = fullName.trim() && email.trim();
  const showStates = useMemo(() => US_STATES, []);

  // ---------- STEP 1 SAVE (back to your working behavior) ----------
  async function saveProfileAndNext() {
    if (!user) return;
    if (!canNext1) {
      alert("Name and email are required");
      return;
    }
    setSaving(true);
    try {
      // keep slug stable (derive from name)
      const slug = slugify(fullName);

      // upsert on user_id (your table has user_id PK or unique)
      const { error } = await supabase
        .from("agent_profiles")
        .upsert({
          user_id: user.id,
          slug,
          full_name: fullName,
          email,
          phone,
          short_bio: shortBio,
          npn,
          published: false,
          headshot_url: headshotUrl || null,
        }, { onConflict: "user_id" });

      if (error) throw error;

      setStep(2);
    } catch (e) {
      alert(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ---------- STEP 2: HEADSHOT ----------
  async function uploadHeadshot() {
    if (!user || !headshotFile) return;
    setSaving(true);
    try {
      // bucket + folder MUST match your storage: agent_public_v2/profile-pictures
      const bucket = "agent_public_v2";
      const fileName = `${user.id}-${Date.now()}-${headshotFile.name}`.replace(/\s+/g, "_");
      const storagePath = `profile-pictures/${fileName}`;

      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(storagePath, headshotFile, {
          cacheControl: "3600",
          upsert: false,
          contentType: headshotFile.type || "application/octet-stream",
        });

      if (upErr) throw upErr;

      const { data: publicUrlData } = supabase
        .storage
        .from(bucket)
        .getPublicUrl(storagePath);

      const publicUrl = publicUrlData?.publicUrl;
      if (!publicUrl) throw new Error("Could not get public URL for headshot");

      // save URL to profile
      const { error: upsertErr } = await supabase
        .from("agent_profiles")
        .upsert({
          user_id: user.id,
          headshot_url: publicUrl,
        }, { onConflict: "user_id" });

      if (upsertErr) throw upsertErr;

      setHeadshotUrl(publicUrl);
      alert("Headshot uploaded.");
    } catch (e) {
      alert(`Headshot upload failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // ---------- STEP 3: STATES & LICENSES ----------
  function toggleState(code) {
    setSelectedStates(prev => prev.includes(code)
      ? prev.filter(c => c !== code)
      : [...prev, code]
    );
  }

  function setLicenseNumber(code, val) {
    setLicenseNumbers(p => ({ ...p, [code]: val }));
  }

  function setLicenseFile(code, file) {
    setLicenseFiles(p => ({ ...p, [code]: file }));
  }

  async function uploadLicenseFile(code) {
    if (!user) return null;
    const f = licenseFiles[code];
    if (!f) return null;

    const bucket = "agent_public_v2";
    const safe = `${user.id}-${code}-${Date.now()}-${f.name}`.replace(/\s+/g, "_");
    // store in the public bucket under showcase/licenses
    const storagePath = `showcase/licenses/${safe}`;

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(storagePath, f, {
        upsert: false,
        cacheControl: "3600",
        contentType: f.type || "application/octet-stream",
      });

    if (upErr) throw upErr;

    const { data: u } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    const url = u?.publicUrl || null;
    if (url) {
      setLicenseUrls(prev => ({ ...prev, [code]: url }));
    }
    return url;
  }

  // ✅ Fixed: this will always set state_name, and it won’t get stuck if the UNIQUE isn’t present
  async function saveStatesAndNext() {
    if (!user) return;
    setSaving(true);
    try {
      // upload files first (pdf or image)
      for (const code of selectedStates) {
        if (licenseFiles[code]) {
          await uploadLicenseFile(code);
        }
      }

      // build rows and ALWAYS include state_name
      const rows = selectedStates.map(code => ({
        user_id: user.id,
        state_code: code,
        state_name: STATE_NAME[code] || code, // never null
        license_number: licenseNumbers[code] || null,
        license_image_url: licenseUrls[code] || null,
      }));

      // try upsert if you have UNIQUE(user_id, state_code)
      let { error } = await supabase
        .from("agent_states")
        .upsert(rows, { onConflict: "user_id,state_code" });

      // if the constraint doesn't exist, fall back to delete+insert
      if (error && /on conflict|conflict/i.test(error.message)) {
        await supabase.from("agent_states").delete().eq("user_id", user.id);
        const ins = await supabase.from("agent_states").insert(rows);
        error = ins.error || null;
      }
      if (error) throw error;

      alert("States saved.");
      setStep(4);
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // ---------- RENDER ----------
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-2xl font-semibold mb-2">Agent Showcase</h1>
        <p className="text-white/70 mb-6">
          Fill these steps to generate your personal “Agent Showcase” page.
        </p>

        {/* Stepper */}
        <div className="flex gap-2 mb-6 text-xs">
          {[1,2,3,4].map(n => (
            <span key={n}
              className={`rounded-full px-3 py-1 border ${step===n ? "bg-white text-black" : "border-white/20 text-white/70"}`}>
              Step {n}
            </span>
          ))}
        </div>

        {step === 1 && (
          <motion.div
            initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
            <h2 className="font-semibold mb-4">Profile</h2>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-white/70">Full Name</label>
                <input value={fullName} onChange={e=>setFullName(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2" />
              </div>

              <div>
                <label className="text-sm text-white/70">Email</label>
                <input value={email} onChange={e=>setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2" />
              </div>

              <div>
                <label className="text-sm text-white/70">Phone</label>
                <input value={phone} onChange={e=>setPhone(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2" />
              </div>

              <div>
                <label className="text-sm text-white/70">NPN</label>
                <input value={npn} onChange={e=>setNpn(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2" />
              </div>

              <div className="md:col-span-2">
                <label className="text-sm text-white/70">Short Bio</label>
                <textarea value={shortBio} onChange={e=>setShortBio(e.target.value)} rows={4}
                  className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2" />
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button disabled={!canNext1 || saving}
                onClick={saveProfileAndNext}
                className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50">
                {saving ? "Saving..." : "Save & Next"}
              </button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
            <h2 className="font-semibold mb-4">Headshot</h2>

            <div className="flex items-center gap-4">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setHeadshotFile(e.target.files?.[0] || null)}
                className="text-sm"
              />
              <button
                disabled={!headshotFile || saving}
                onClick={uploadHeadshot}
                className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {saving ? "Uploading..." : "Upload"}
              </button>
            </div>

            {headshotUrl && (
              <div className="mt-4">
                <img src={headshotUrl} alt="Headshot" className="h-28 w-28 rounded-xl object-cover border border-white/10" />
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={() => setStep(3)}
                className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium"
              >
                Next
              </button>
            </div>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div
            initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
            <h2 className="font-semibold mb-4">Licensed States</h2>

            <div className="grid md:grid-cols-3 gap-3">
              {showStates.map((s) => {
                const checked = selectedStates.includes(s.code);
                return (
                  <div key={s.code} className="rounded-lg border border-white/10 p-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleState(s.code)}
                      />
                      <span>{s.name} ({s.code})</span>
                    </label>

                    {checked && (
                      <div className="mt-3 space-y-2">
                        <input
                          placeholder="License number"
                          value={licenseNumbers[s.code] || ""}
                          onChange={(e) => setLicenseNumber(s.code, e.target.value)}
                          className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm"
                        />
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          onChange={(e) => setLicenseFile(s.code, e.target.files?.[0] || null)}
                          className="block w-full text-sm"
                        />
                        {licenseUrls[s.code] && (
                          <a className="text-xs underline" href={licenseUrls[s.code]} target="_blank" rel="noreferrer">
                            View uploaded file
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button disabled={saving}
                onClick={saveStatesAndNext}
                className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50">
                {saving ? "Saving..." : "Save & Next"}
              </button>
            </div>
          </motion.div>
        )}

        {step === 4 && (
          <motion.div
            initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
            <h2 className="font-semibold mb-2">Done</h2>
            <p className="text-white/70">
              Your info is saved. When you’re ready, publish on the Settings page or wherever you control visibility.
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
