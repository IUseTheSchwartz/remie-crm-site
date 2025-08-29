// File: src/pages/AgentShowcase.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import { uploadPublicImage, uploadPrivateDoc } from "../lib/upload";
import { Link, useNavigate } from "react-router-dom";

const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY",
"LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
"RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

function makeSlugFromName(name = "") {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50);
}

export default function AgentShowcase() {
  const [user, setUser] = useState(null);
  const [step, setStep] = useState(1);
  const [profile, setProfile] = useState({
    full_name: "",
    email: "",
    phone: "",
    short_bio: "",
    npn: "",
    headshot_url: "",
    published: false
  });
  const [licensed, setLicensed] = useState(new Set());
  const [headshot, setHeadshot] = useState(null);
  const [licenseFile, setLicenseFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
  }, []);

  useEffect(() => {
    (async () => {
      if (!user?.id) return;
      const { data } = await supabase
        .from("agent_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (data) {
        setProfile(p => ({ ...p, ...data }));
        setSlug(data.slug || makeSlugFromName(data.full_name || ""));
      } else {
        // new profile → default email to auth email
        setProfile(p => ({ ...p, email: user?.email || "" }));
        setSlug(makeSlugFromName(user?.user_metadata?.full_name || user?.email?.split("@")[0] || ""));
      }

      const { data: st } = await supabase
        .from("agent_states")
        .select("state_code")
        .eq("user_id", user.id);
      if (st?.length) setLicensed(new Set(st.map(r => r.state_code)));
    })();
  }, [user?.id]);

  const canNext = useMemo(() => {
    if (step === 1) return profile.full_name && profile.email;
    if (step === 2) return profile.npn?.length > 0;
    if (step === 3) return licensed.size > 0;
    return true;
  }, [step, profile, licensed]);

  const saveStep = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      // uploads
      let publicUrl = profile.headshot_url;
      if (headshot) {
        const up = await uploadPublicImage(user.id, headshot, "headshots");
        publicUrl = up.publicUrl;
      }
      if (licenseFile) {
        const path = await uploadPrivateDoc(user.id, licenseFile, "license");
        await supabase.from("agent_documents").insert({
          user_id: user.id, doc_type: "license", storage_path: path
        });
      }

      const finalSlug = slug || makeSlugFromName(profile.full_name);

      // upsert profile
      await supabase.from("agent_profiles").upsert({
        user_id: user.id,
        slug: finalSlug,
        full_name: profile.full_name,
        email: profile.email,
        phone: profile.phone,
        short_bio: profile.short_bio,
        npn: profile.npn,
        headshot_url: publicUrl || null,
        published: profile.published
      });

      // states (only when leaving step 3)
      if (step === 3) {
        await supabase.from("agent_states").delete().eq("user_id", user.id);
        const rows = Array.from(licensed).map(s => ({ user_id: user.id, state_code: s }));
        if (rows.length) await supabase.from("agent_states").insert(rows);
      }

      if (step < 4) setStep(step + 1);
      else setSlug(finalSlug);
    } catch (e) {
      alert(e.message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      await supabase.from("agent_profiles").update({ published: true }).eq("user_id", user.id);
      alert("Published! Your Agent Showcase page is live.");
      navigate(`/agent/${slug || makeSlugFromName(profile.full_name)}`);
    } catch (e) {
      alert(e.message || "Publish failed");
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p>Please sign in to use Agent Showcase.</p>
        <Link className="text-blue-600 underline" to="/login">Go to login</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-2">Agent Showcase</h1>
      <p className="text-gray-500 mb-6">Step {step} of 4</p>

      {step === 1 && (
        <div className="space-y-4">
          <Input label="Full name" value={profile.full_name}
                 onChange={(v)=>{ setProfile(p=>({...p,full_name:v})); setSlug(makeSlugFromName(v)); }} />
          <Input label="Email" value={profile.email}
                 onChange={(v)=>setProfile(p=>({...p,email:v}))}/>
          <Input label="Phone" value={profile.phone}
                 onChange={(v)=>setProfile(p=>({...p,phone:v}))}/>
          <Textarea label="Short bio" value={profile.short_bio}
                    onChange={(v)=>setProfile(p=>({...p,short_bio:v}))}/>
          <div>
            <div className="text-sm text-gray-600 mb-1">Headshot</div>
            {profile.headshot_url && <img src={profile.headshot_url} alt="" className="h-24 rounded-lg mb-2" />}
            <input type="file" accept="image/*" onChange={(e)=>setHeadshot(e.target.files?.[0]||null)} />
          </div>
          <div className="text-sm text-gray-500">
            Your public link will be: <code>/agent/{slug || "first-last"}</code>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Input label="NPN" value={profile.npn}
                 onChange={(v)=>setProfile(p=>({...p,npn:v}))}/>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-2">
          <div className="text-sm text-gray-600">Licensed states</div>
          <div className="grid grid-cols-6 gap-2">
            {STATES.map(s => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={licensed.has(s)}
                  onChange={(e)=>{
                    setLicensed(prev=>{
                      const next = new Set(prev);
                      e.target.checked ? next.add(s) : next.delete(s);
                      return next;
                    });
                  }}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div>
            <div className="text-sm text-gray-600 mb-1">Upload license (image/pdf)</div>
            <input type="file" accept="image/*,.pdf" onChange={(e)=>setLicenseFile(e.target.files?.[0]||null)} />
          </div>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={profile.published}
              onChange={(e)=>setProfile(p=>({...p,published:e.target.checked}))}
            />
            <span>Publish my profile (public)</span>
          </label>
        </div>
      )}

      <div className="mt-6 flex gap-3">
        {step > 1 && (
          <button className="px-4 py-2 rounded-xl border" disabled={busy} onClick={()=>setStep(step-1)}>
            Back
          </button>
        )}
        {step < 4 ? (
          <button className="px-4 py-2 rounded-xl bg-black text-white disabled:opacity-50"
                  onClick={saveStep} disabled={!canNext || busy}>
            {busy ? "Saving..." : "Save & Next"}
          </button>
        ) : (
          <>
            <button className="px-4 py-2 rounded-xl border" disabled={busy} onClick={saveStep}>
              Save
            </button>
            <button className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50"
                    onClick={publish} disabled={busy || !profile.published}>
              Publish
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Input({ label, value, onChange, placeholder }) {
  return (
    <div>
      <div className="text-sm text-gray-600 mb-1">{label}</div>
      <input
        className="w-full border rounded-xl px-3 py-2"
        value={value || ""} placeholder={placeholder}
        onChange={(e)=>onChange(e.target.value)}
      />
    </div>
  );
}
function Textarea({ label, value, onChange }) {
  return (
    <div>
      <div className="text-sm text-gray-600 mb-1">{label}</div>
      <textarea
        className="w-full border rounded-xl px-3 py-2 min-h-28"
        value={value || ""} onChange={(e)=>onChange(e.target.value)}
      />
    </div>
  );
}
