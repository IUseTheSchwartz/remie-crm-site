// File: src/pages/CalendarPage.jsx
import { useEffect, useState } from "react";
import { InlineWidget } from "react-calendly";
import { supabase } from "../lib/supabaseClient";

export default function CalendarPage() {
  const [url, setUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      const { data } = await supabase
        .from("agent_profiles")
        .select("calendly_url")
        .eq("user_id", uid)
        .maybeSingle();

      if (data?.calendly_url) {
        setUrl(data.calendly_url);
        setInputUrl(data.calendly_url);
      }
    })();
  }, []);

  async function saveUrl() {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return alert("Please log in");

    const { error } = await supabase
      .from("agent_profiles")
      .update({ calendly_url: inputUrl })
      .eq("user_id", uid);

    if (error) {
      console.error(error);
      alert("Failed to save");
    } else {
      setUrl(inputUrl);
    }
  }

  return (
    <div className="p-6 text-white">
      <h1 className="text-2xl font-semibold mb-4">My Calendar</h1>

      <div className="mb-4">
        <label className="block mb-1 text-sm">Calendly URL</label>
        <input
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="https://calendly.com/yourname"
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
        />
        <button
          onClick={saveUrl}
          className="mt-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200"
        >
          Save
        </button>
      </div>

      {url ? (
        <div className="mt-6">
          <InlineWidget url={url} styles={{ height: "700px" }} />
        </div>
      ) : (
        <p className="text-white/60">No Calendly URL set yet.</p>
      )}
    </div>
  );
}
