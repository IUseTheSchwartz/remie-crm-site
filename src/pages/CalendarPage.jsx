// File: src/pages/CalendarPage.jsx
import { useEffect, useMemo, useState } from "react";
import { InlineWidget } from "react-calendly";

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-white/70">{label}</div>
      {children}
    </label>
  );
}

export default function CalendarPage() {
  const [calendlyUrl, setCalendlyUrl] = useState("");
  const [temp, setTemp] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("calendly_url") || "";
    setCalendlyUrl(stored);
    setTemp(stored);
  }, []);

  const isValid = useMemo(() => {
    if (!temp) return false;
    try {
      const u = new URL(temp);
      return u.hostname.includes("calendly.com");
    } catch {
      return false;
    }
  }, [temp]);

  function save() {
    if (!isValid) {
      alert("Enter a valid Calendly URL (e.g. https://calendly.com/yourname/30min).");
      return;
    }
    window.localStorage.setItem("calendly_url", temp);
    setCalendlyUrl(temp);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 ring-1 ring-white/5">
        <h1 className="text-lg font-semibold">Calendar</h1>
        <p className="mt-1 text-sm text-white/70">
          Paste your Calendly scheduling link to book meetings inside the CRM.
          Use your main page (e.g., <code className="text-white/90">https://calendly.com/yourname</code>)
          or a specific event (e.g., <code className="text-white/90">https://calendly.com/yourname/30min</code>).
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="Calendly URL">
            <input
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              placeholder="https://calendly.com/yourname/30min"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
            />
          </Field>
          <button
            onClick={save}
            className="h-[38px] rounded-lg bg-white px-4 text-sm font-medium text-black hover:bg-neutral-200"
          >
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 ring-1 ring-white/5">
        <h2 className="text-sm font-semibold mb-3">Preview</h2>
        {!calendlyUrl ? (
          <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-white/60">
            No Calendly link saved yet. Paste your link above and click <span className="text-white">Save</span>.
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-black/40 p-2">
            <InlineWidget
              url={calendlyUrl}
              styles={{ height: "760px", minHeight: "760px", width: "100%" }}
              pageSettings={{
                backgroundColor: "0a0a0a",
                hideEventTypeDetails: false,
                hideLandingPageDetails: false,
                primaryColor: "6366f1", // indigo-500 (hex without '#')
                textColor: "ffffff",
              }}
            />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/60">
        <div className="font-semibold mb-1">Tips</div>
        <ul className="list-disc pl-5 space-y-1">
          <li>Use a specific event type (15/30/60 min) for consistent bookings.</li>
          <li>You can change the link anytime; it updates instantly here.</li>
          <li>Later we can sync upcoming events via a small server proxy to Calendly’s API.</li>
        </ul>
      </div>
    </div>
  );
}
