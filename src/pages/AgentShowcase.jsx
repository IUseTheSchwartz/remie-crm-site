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

const slugify = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

/* ---------- Small UI helper ---------- */
function Field({ label, children, full }) {
  return (
    <label className={`block ${full ? "md:col-span-2" : ""}`}>
      <div className="mb-1 text-xs font-medium text-white/70">{label}</div>
      {children}
    </label>
  );
}

/* ---------- Page ---------- */
export default function AgentShowcase() {
  const nav = useNavigate();

  // wizard step
  const [step, setStep] = useState(1);

  // Step 1 profile
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [shortBio, setShortBio] = useState("");
  const [npn, setNpn] = useState("");
  const slug = useMemo(() => slugify(fullName) || "my-profile", [fullName]);

  // Step 2 headshot
  const [headshotFile, setHeadshotFile] = useState(null);
  const [headshotUrl, setHeadshotUrl] = useState("");

  // Step 3 states (rich)
  // stateMap: { [state_code]: { selected: bool, license_number: string, license_image_url: string, file?: File } }
  const [stateMap, setStateMap] = useState({});
  const [savingStates, setSavingStates] = useState(false);

  // publish
  const [published, setPublished] = useState(false);

  const [loading, setLoading] = useState(false);

  /* ---------- Load existing ---------- */
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      // profile
      const { data: prof } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();
      if (prof) {
        setFullName(prof.full_name || "");
        setEmail(prof.email || auth.user.email || "");
        setPhone(prof.phone || "");
        setShortBio(prof.short_bio || "");
        setNpn(prof.npn || "");
        setPublished(!!prof.published);
        setHeadshotUrl(prof.headshot_url || "");
      } else {
        setEmail(auth.user?.email || "");
      }

      // states
      const { data: st } = await supabase
        .from("agent_states")
        .select("state_code, license_number, license_image_url")
        .eq("user_id", uid);

      if (st?.length) {
        const next = {};
        for (const r of st) {
          next[r.state_code] = {
            selected: true,
            license_number: r.license_number || "",
            license_image_url: r.license_image_url || "",
          };
        }
        setStateMap(next);
      }
    })();
  }, []);

  /* ---------- Step 1: Save profile ---------- */
  async function saveProfile() {
    setLoading(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      const { error } = await supabase.from("agent_profiles").upsert(
        {
          user_id: uid,
          slug,
          full_name: fullName,
          email,
          phone,
          short_bio: shortBio,
          npn,
          published,
          headshot_url: headshotUrl || null,
          updated_at: new Date().toISOString(),
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

      const ext = (headshotFile.name.split(".").pop() || "jpg").toLowerCase();
      const key = `profile-pictures/${uid}/${Date.now()}.${ext}`;
      const bucket = supabase.storage.from("agent_public_v2");

      const { error: upErr } = await bucket.upload(key, headshotFile, {
        upsert: true,
        contentType: headshotFile.type || "image/jpeg",
        cacheControl: "3600",
      });
      if (upErr) throw upErr;

      const { data: pub } = bucket.getPublicUrl(key);
      const publicUrl = pub?.publicUrl;
      if (!publicUrl) throw new Error("Could not get public URL");

      setHeadshotUrl(publicUrl);

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

  /* ---------- Step 3: per-state UI helpers ---------- */
  const isSelected = (code) => !!stateMap[code]?.selected;

  function toggleState(code) {
    setStateMap((prev) => {
      const next = { ...prev };
      const cur = next[code] || { selected: false, license_number: "", license_image_url: "" };
      next[code] = { ...cur, selected: !cur.selected };
      return next;
    });
  }

  function setLicenseNumber(code, value) {
    setStateMap((prev) => {
      const cur = prev[code] || { selected: true, license_number: "", license_image_url: "" };
      return { ...prev, [code]: { ...cur, license_number: value } };
    });
  }

  function setLicenseFile(code, file) {
    setStateMap((prev) => {
      const cur = prev[code] || { selected: true, license_number: "", license_image_url: "" };
      return { ...prev, [code]: { ...cur, file } };
    });
  }

  /* ---------- Step 3: Save (diff-based with uploads; accepts PDF) ---------- */
  async function saveStates() {
    setSavingStates(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Please log in");

      // Validate selected states have both license number and file/url
      const selectedCodes = Object.keys(stateMap).filter((c) => stateMap[c]?.selected);
      for (const code of selectedCodes) {
        const item = stateMap[code];
        if (!item.license_number?.trim()) throw new Error(`Please enter a license number for ${code}.`);
        if (!item.license_image_url && !item.file) throw new Error(`Please upload a license image/PDF for ${code}.`);
      }

      // Existing rows
      const { data: existingRows, error: selErr } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", uid);
      if (selErr) throw selErr;

      const existing = new Set((existingRows || []).map((r) => r.state_code));
      const desired = new Set(selectedCodes);
      const toDelete = [...existing].filter((c) => !desired.has(c));

      // Upload any pending files and collect rows to upsert
      const rowsToUpsert = [];
      const bucket = supabase.storage.from("agent_public_v2");

      for (const code of selectedCodes) {
        let license_image_url = stateMap[code].license_image_url || "";
        if (stateMap[code].file) {
          const file = stateMap[code].file;
          const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
          const key = `licenses/${uid}/${code}-${Date.now()}.${ext}`;

          const { error: upErr } = await bucket.upload(key, file, {
            upsert: true,
            contentType: file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"),
            cacheControl: "3600",
          });
          if (upErr) throw upErr;

          const { data: pub } = bucket.getPublicUrl(key);
          license_image_url = pub?.publicUrl || "";
        }

        rowsToUpsert.push({
          user_id: uid,
          state_code: code,
          license_number: stateMap[code].license_number || null,
          license_image_url: license_image_url || null,
          updated_at: new Date().toISOString(),
        });
      }

      // Upsert selected rows (uses composite conflict on user_id,state_code)
      if (rowsToUpsert.length) {
        const { error: upErr } = await supabase
          .from("agent_states")
          .upsert(rowsToUpsert, { onConflict: "user_id,state_code" });
        if (upErr) throw upErr;
      }

      // Delete unselected rows
      if (toDelete.length) {
        const { error: delErr } = await supabase
          .from("agent_states")
          .delete()
          .eq("user_id", uid)
          .in("state_code", toDelete);
        if (delErr) throw delErr;
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
  const publicUrl = `${window.location.origin}/a/${slug}`;

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
          <p className="text-sm text-white/80">
            Select your licensed states, add the license number for each, and upload a clear image <em>or PDF</em> of the license.
          </p>

          <div className="space-y-3">
            {STATES.map((s) => {
              const entry = stateMap[s.code] || { selected: false, license_number: "", license_image_url: "" };
              const selected = !!entry.selected;

              return (
                <div key={s.code} className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleState(s.code)}
                      />
                      <span className="font-medium">{s.name}</span>
                      <span className="text-white/50">({s.code})</span>
                    </label>
                  </div>

                  {selected && (
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="md:col-span-1">
                        <div className="text-xs text-white/70 mb-1">License Number</div>
                        <input
                          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
                          value={entry.license_number || ""}
                          onChange={(e) => setLicenseNumber(s.code, e.target.value)}
                          placeholder="e.g. 1234567"
                        />
                      </div>

                      <div className="md:col-span-1">
                        <div className="text-xs text-white/70 mb-1">Upload License (image or PDF)</div>
                        <input
                          type="file"
                          accept="image/*,.pdf"
                          onChange={(e) => setLicenseFile(s.code, e.target.files?.[0] || null)}
                          className="block text-sm"
                        />
                      </div>

                      <div className="md:col-span-1">
                        <div className="text-xs text-white/70 mb-1">Current File</div>
                        {entry.license_image_url ? (
                          entry.license_image_url.toLowerCase().includes(".pdf") ? (
                            <a
                              href={entry.license_image_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-indigo-300 underline"
                            >
                              View PDF
                            </a>
                          ) : (
                            <img
                              src={entry.license_image_url}
                              alt={`${s.code} license`}
                              className="h-20 w-32 rounded-lg border border-white/10 object-cover"
                            />
                          )
                        ) : (
                          <div className="grid h-20 w-32 place-items-center rounded-lg border border-dashed border-white/15 text-xs text-white/50">
                            None uploaded
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
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
              <input type="checkbox" checked={published} onChange={(e) => setPublish(e.target.checked)} />
              <span>Publish my page</span>
            </label>
          </div>

          <div className="mt-4 flex items-center justify-end">
            <button
              onClick={() => {
                // Signal sidebar to refresh its link state immediately
                window.localStorage.setItem("agent_profile_refresh", Date.now().toString());
                // Send user back to the app home where the sidebar lives
                nav("/app");
              }}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200"
            >
              Done — View My Agent Site
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
