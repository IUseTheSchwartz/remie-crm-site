// File: src/pages/AgentShowcase.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import supabase from "../lib/supabaseClient"; // export default supabase in your client
import { useAuth } from "../auth.jsx";

export default function AgentShowcase() {
  const { user } = useAuth();
  const nav = useNavigate();

  const [loading, setLoading] = useState(true);

  // Step 1 fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [phone, setPhone]         = useState("");
  const [bio, setBio]             = useState(""); // <- UI state; maps to `short_bio` in DB
  const [photoFile, setPhotoFile] = useState(null);
  const [photoUrl, setPhotoUrl]   = useState("");

  // Step 2 fields (IDs / licenses)
  const [npn, setNpn] = useState("");
  const [states, setStates] = useState([]); // text[] in DB

  useEffect(() => {
    if (!user) return;
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function loadProfile() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("agent_profiles")
        .select(
          "first_name,last_name,email,phone,short_bio,profile_picture_url,npn,state_licenses"
        )
        .eq("id", user.id)
        .single();

      if (error && error.code !== "PGRST116") throw error; // 116 = row not found

      if (data) {
        setFirstName(data.first_name ?? "");
        setLastName(data.last_name ?? "");
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
        setBio(data.short_bio ?? "");                  // <-- read from short_bio
        setPhotoUrl(data.profile_picture_url ?? "");
        setNpn(data.npn ?? "");
        setStates(data.state_licenses ?? []);
      } else {
        // Prefill known fields for first-time users
        setEmail(user.email ?? "");
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function uploadPublicPhoto(file) {
    if (!file || !user) return "";
    const filePath = `profiles/${user.id}/${Date.now()}_${file.name}`;
    const bucket = supabase.storage.from("agent_public_v2"); // your v2 bucket

    const { error: upErr } = await bucket.upload(filePath, file, {
      upsert: true,
      contentType: file.type,
    });
    if (upErr) throw upErr;

    const { data: pub } = bucket.getPublicUrl(filePath);
    return pub?.publicUrl || "";
  }

  async function saveStep1() {
    try {
      setLoading(true);

      // Upload new photo if selected
      let finalPhotoUrl = photoUrl;
      if (photoFile) {
        finalPhotoUrl = await uploadPublicPhoto(photoFile);
        setPhotoUrl(finalPhotoUrl);
      }

      // Map UI state -> DB columns
      const payload = {
        id: user.id,                    // user owns their row
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        short_bio: bio,                 // <-- WRITE TO short_bio (not bio)
        profile_picture_url: finalPhotoUrl,
        npn,
        state_licenses: states,
      };

      const { error } = await supabase
        .from("agent_profiles")
        .upsert(payload, { onConflict: "id" });

      if (error) throw error;

      alert("Saved!");
      // advance to next step or wherever you want
      // nav("/app/agent-showcase/states") etc…
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || !user;

  return (
    <div className="mx-auto max-w-3xl p-4 text-white">
      <h1 className="text-2xl font-semibold mb-3">Agent Showcase</h1>
      <p className="text-white/70 mb-6">
        Fill in your details. Your short bio and photo will appear on your public page.
      </p>

      {/* Step 1: Profile */}
      <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm text-white/70">First Name</label>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
          <div>
            <label className="text-sm text-white/70">Last Name</label>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm text-white/70">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
          <div>
            <label className="text-sm text-white/70">Phone</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
        </div>

        <div>
          <label className="text-sm text-white/70">Short Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={5}
            className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
            placeholder="A few lines about how you help families…"
            disabled={disabled}
          />
        </div>

        <div>
          <label className="text-sm text-white/70">Profile Picture</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
            className="mt-1 block"
            disabled={disabled}
          />
          {photoUrl ? (
            <img
              src={photoUrl}
              alt="Profile"
              className="mt-2 h-28 w-28 rounded-lg object-cover ring-1 ring-white/10"
            />
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm text-white/70">NPN</label>
            <input
              value={npn}
              onChange={(e) => setNpn(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
          <div>
            <label className="text-sm text-white/70">Licensed States (comma separated)</label>
            <input
              value={states.join(", ")}
              onChange={(e) =>
                setStates(
                  e.target.value
                    .split(",")
                    .map((s) => s.trim().toUpperCase())
                    .filter(Boolean)
                )
              }
              className="mt-1 w-full rounded-lg bg-black/30 p-2 outline-none ring-1 ring-white/10"
              disabled={disabled}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={saveStep1}
            disabled={disabled}
            className="rounded-lg bg-white/10 px-4 py-2 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-60"
          >
            Save & Continue
          </button>
        </div>
      </div>
    </div>
  );
}
