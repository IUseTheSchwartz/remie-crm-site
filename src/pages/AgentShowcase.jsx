import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useNavigate } from "react-router-dom";

/* ---------- helpers ---------- */

async function getUid() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

function toSlug(name = "", fallback = "") {
  const s = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return s || fallback;
}

const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY"
];

/* ---------- tiny UI bits ---------- */

function Section({ title, subtitle, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold">{title}</div>
        {subtitle && <div className="text-xs text-white/70">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <label className="block text-sm mb-3">
      <div className="mb-1 text-white/80">{label}</div>
      <input
        className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        {...props}
      />
    </label>
  );
}

/* ---------- Page (wizard) ---------- */

export default function AgentShowcase() {
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Step 1 model
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    short_bio: "",
    npn: "",
  });

  // Step 2: headshot
  const [headshotUrl, setHeadshotUrl] = useState("");

  // Step 3: states
  const [licensed, setLicensed] = useState([]);

  // Derived slug
  const slug = useMemo(() => toSlug(form.full_name), [form.full_name]);

  /* ----- load existing data ----- */
  useEffect(() => {
    (async () => {
      try {
        const uid = await getUid();

        // profile
        const { data: prof, error: e1 } = await supabase
          .from("agent_profiles")
          .select("*")
          .eq("user_id", uid)
          .maybeSingle();
        if (e1) throw e1;
        if (prof) {
          setForm({
            full_name: prof.full_name || "",
            email: prof.email || "",
            phone: prof.phone || "",
            short_bio: prof.short_bio || "",
            npn: prof.npn || "",
          });
          setHeadshotUrl(prof.headshot_url || "");
        }

        // states
        const { data: stRows, error: e2 } = await supabase
          .from("agent_states")
          .select("state_code")
          .eq("user_id", uid);
        if (e2) throw e2;
        if (stRows?.length) setLicensed(stRows.map((r) => r.state_code));
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  /* ----- actions for each step ----- */

  async function saveStep1() {
    setSaving(true);
    try {
      const uid = await getUid();
      const generatedSlug = toSlug(form.full_name, uid.slice(0, 8));

      const payload = {
        user_id: uid,
        slug: generatedSlug,
        full_name: form.full_name,
        email: form.email,
        phone: form.phone,
        short_bio: form.short_bio,
        npn: form.npn,
        // keep existing values untouched if present:
        // published/headshot_url handled in other steps
      };

      const { error } = await supabase
        .from("agent_profiles")
        .upsert(payload, { onConflict: "user_id" });
      if (error) throw error;

      setStep(2);
    } catch (err) {
      alert(err.message);
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function uploadHeadshot(file) {
    if (!file) return;
    setSaving(true);
    try {
      const uid = await getUid();
      const ext = file.name.split(".").pop();
      const key = `profile-pictures/${uid}/${Date.now()}.${ext}`;

      // Upload to agent_public_v2
      const { error: upErr } = await supabase.storage
        .from("agent_public_v2")
        .upload(key, file, { upsert: true, cacheControl: "3600" });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage
        .from("agent_public_v2")
        .getPublicUrl(key);

      const publicUrl = pub?.publicUrl || "";

      const { error: updErr } = await supabase
        .from("agent_profiles")
        .update({ headshot_url: publicUrl })
        .eq("user_id", uid);
      if (updErr) throw updErr;

      setHeadshotUrl(publicUrl);
      setStep(3);
    } catch (err) {
      alert(`Headshot upload failed: ${err.message}`);
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function saveStates() {
    setSaving(true);
    try {
      const uid = await getUid();

      // replace all states for this user
      const { error: delErr } = await supabase
        .from("agent_states")
        .delete()
        .eq("user_id", uid);
      if (delErr) throw delErr;

      const rows = licensed.map((code) => ({ user_id: uid, state_code: code }));
      if (rows.length) {
        const { error: insErr } = await supabase
          .from("agent_states")
          .insert(rows);
        if (insErr) throw insErr;
      }

      setStep(4);
    } catch (err) {
      alert(err.message);
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function publishProfile() {
    setSaving(true);
    try {
      const uid = await getUid();
      const { error } = await supabase
        .from("agent_profiles")
        .update({ published: true })
        .eq("user_id", uid);
      if (error) throw error;

      alert("Your Agent Showcase is published!");
      nav("/app"); // back to app home
    } catch (err) {
      alert(err.message);
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  /* ---------- render ---------- */

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-semibold">Agent Showcase</h1>
      <p className="text-white/70 text-sm">
        Create your public agent page in a few quick steps. You can update this
        any time.
      </p>

      {/* Step indicator */}
      <div className="flex gap-2 text-xs">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`px-2 py-1 rounded-lg border ${
              step === i
                ? "border-indigo-400 bg-indigo-400/10"
                : "border-white/10 bg-white/5"
            }`}
          >
            Step {i}
          </div>
        ))}
      </div>

      {/* STEP 1: profile */}
      {step === 1 && (
        <Section
          title="Profile"
          subtitle="Your basic contact info shown on the public page"
        >
          <div className="grid md:grid-cols-2 gap-4">
            <Field
              label="Full name"
              value={form.full_name}
              onChange={(e) =>
                setForm((f) => ({ ...f, full_name: e.target.value }))
              }
            />
            <Field
              label="Email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
            />
            <Field
              label="Phone"
              value={form.phone}
              onChange={(e) =>
                setForm((f) => ({ ...f, phone: e.target.value }))
              }
            />
            <Field
              label="National Producer Number (NPN)"
              value={form.npn}
              onChange={(e) =>
                setForm((f) => ({ ...f, npn: e.target.value }))
              }
            />
          </div>

          <label className="block text-sm mt-3">
            <div className="mb-1 text-white/80">Short bio</div>
            <textarea
              className="w-full min-h-[120px] rounded-lg bg-black/30 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              value={form.short_bio}
              onChange={(e) =>
                setForm((f) => ({ ...f, short_bio: e.target.value }))
              }
              placeholder="Tell clients how you help families. Keep it friendly and clear."
            />
          </label>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-white/60">
              Slug preview: <span className="font-mono">{slug || "…"}</span>
            </div>
            <button
              disabled={saving}
              onClick={saveStep1}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Next"}
            </button>
          </div>
        </Section>
      )}

      {/* STEP 2: headshot */}
      {step === 2 && (
        <Section
          title="Headshot"
          subtitle="Upload a clear professional photo. PNG or JPG."
        >
          {headshotUrl ? (
            <div className="mb-3">
              <img
                src={headshotUrl}
                alt="Headshot"
                className="h-40 w-40 object-cover rounded-xl border border-white/10"
              />
            </div>
          ) : null}

          <input
            type="file"
            accept="image/*"
            onChange={(e) => uploadHeadshot(e.target.files?.[0])}
          />

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500"
            >
              Continue
            </button>
          </div>
        </Section>
      )}

      {/* STEP 3: states */}
      {step === 3 && (
        <Section
          title="Licensed States"
          subtitle="Select the states where you are licensed"
        >
          <div className="grid grid-cols-6 gap-2 max-h-[280px] overflow-auto p-2 rounded-lg bg-black/20 border border-white/10">
            {ALL_STATES.map((code) => {
              const active = licensed.includes(code);
              return (
                <button
                  key={code}
                  onClick={() =>
                    setLicensed((arr) =>
                      arr.includes(code)
                        ? arr.filter((c) => c !== code)
                        : [...arr, code]
                    )
                  }
                  className={`text-xs px-2 py-1 rounded border ${
                    active
                      ? "bg-indigo-600 border-indigo-500"
                      : "bg-white/5 border-white/10"
                  }`}
                >
                  {code}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5"
            >
              Back
            </button>
            <button
              disabled={saving}
              onClick={saveStates}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save & Continue"}
            </button>
          </div>
        </Section>
      )}

      {/* STEP 4: review & publish */}
      {step === 4 && (
        <Section title="Review & Publish">
          <div className="flex gap-4">
            {headshotUrl ? (
              <img
                src={headshotUrl}
                alt="Headshot"
                className="h-28 w-28 object-cover rounded-xl border border-white/10"
              />
            ) : (
              <div className="h-28 w-28 rounded-xl border border-dashed border-white/15 grid place-items-center text-xs text-white/50">
                No photo
              </div>
            )}

            <div className="text-sm">
              <div className="font-semibold">{form.full_name || "—"}</div>
              <div className="text-white/70">{form.email || "—"}</div>
              <div className="text-white/70">{form.phone || "—"}</div>
              <div className="mt-2 text-white/80">{form.short_bio || "—"}</div>
              <div className="mt-2 text-xs text-white/60">
                NPN: {form.npn || "—"}
              </div>
              <div className="mt-1 text-xs text-white/60">
                States: {licensed.length ? licensed.join(", ") : "—"}
              </div>
              <div className="mt-1 text-xs text-white/60">
                Slug: <span className="font-mono">{slug || "…"}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5"
            >
              Back
            </button>
            <button
              disabled={saving}
              onClick={publishProfile}
              className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-60"
            >
              {saving ? "Publishing…" : "Publish"}
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
