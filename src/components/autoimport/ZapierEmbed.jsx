// File: src/components/autoimport/ZapierEmbed.jsx
import React, { useMemo } from "react";

export default function ZapierEmbed() {
  const EMAIL = "remiecrmleads@gmail.com";

  const emailSubject = "Auto-Import Leads – Setup Request";
  const emailBodyEncoded = useMemo(() => {
    const lines = [
      "Hi,",
      "",
      "Please set up Auto-Import Leads for my account.",
      "",
      "• My Remie CRM email:",
      "• Lead type(s): (e.g., Veteran, FEX)",
      "• Google Sheet name:",
      "• Google Sheet link:",
      "",
      "I have shared the sheet with remiecrmleads@gmail.com.",
      "",
      "Thanks!",
    ];
    return encodeURIComponent(lines.join("\n"));
  }, []);

  const mailto = `mailto:${EMAIL}?subject=${encodeURIComponent(
    emailSubject
  )}&body=${emailBodyEncoded}`;

  async function copy(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      alert("Copied!");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      alert("Copied!");
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Auto-Import Leads</h3>

      {/* Steps (same visual style as before) */}
      <div className="space-y-2">
        <div className="font-medium">Steps:</div>
        <ol className="list-decimal list-inside space-y-1">
          <li>
            Share your Google Sheet with{" "}
            <span className="font-mono">{EMAIL}</span>.
          </li>
          <li>
            Email me the details:
            <ul className="ml-5 list-disc">
              <li>Your Remie CRM email</li>
              <li>Lead type(s) — e.g., Veteran, FEX</li>
              <li>Google Sheet name + link</li>
            </ul>
          </li>
        </ol>
      </div>

      {/* Quick actions */}
      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => copy(EMAIL)}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1"
            title="Copy email address"
          >
            Copy email address
          </button>
          <a
            href={mailto}
            className="rounded-md bg-white px-3 py-1 text-sm font-medium text-black hover:bg-white/90"
          >
            Compose email
          </a>
        </div>
        <p className="mt-3 text-xs text-white/60">
          I’ll complete setup within <b>1–12 hours</b> and email you when it’s
          done. After that, new rows in your sheet will auto-import into Remie.
        </p>
      </div>
    </div>
  );
}
