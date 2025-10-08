// File: src/components/autoimport/ZapierEmbed.jsx
import React, { useMemo } from "react";

export default function ZapierEmbed() {
  const EMAIL = "remiecrmleads@gmail.com";

  const emailSubject = "Auto-Import Leads – Setup Request";
  const emailBodyEncoded = useMemo(() => {
    const lines = [
      "Hi Remie CRM team,",
      "",
      "Please set up Auto-Import Leads for my account.",
      "",
      "• My Remie CRM username (email):",
      "• My Remie CRM password:",
      "• Lead type(s): (e.g., Veteran, FEX)",
      "• Google Sheet link(s):",
      "",
      "I have shared the Google Sheet with remiecrmleads@gmail.com.",
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
      // fallback
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
    <div className="space-y-4 text-sm text-white/85">
      <div>
        <div className="text-lg font-semibold">Auto-Import Leads</div>
        <p className="mt-1 text-white/60">
          We’ll wire your Google Sheet so new rows flow into Remie automatically.
          No extra tools needed.
        </p>
      </div>

      {/* Step 1 */}
      <Card>
        <h3 className="text-base font-semibold">Step 1 — Share your Google Sheet</h3>
        <p className="mt-1 text-white/70">
          Share your leads spreadsheet with <span className="font-mono">{EMAIL}</span>.
          Viewer is fine; Editor helps if we need to tidy headers.
        </p>

        <div className="mt-3 grid gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
          <Label>Columns we can read</Label>
          <ul className="list-disc pl-5 text-white/75">
            <li><b>Required:</b> at least one of: name, phone, email</li>
            <li><b>Optional:</b> dob, state, beneficiary, beneficiary_name, gender, military_branch, notes</li>
          </ul>
          <p className="mt-2 text-xs text-white/50">
            Header names don’t need to match exactly—common variations like “First Name”, “Cell”, “Email Address” work.
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => copy(EMAIL)}
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2"
            title="Copy email"
          >
            Copy email
          </button>
          <a
            href="https://support.google.com/docs/answer/9331169?hl=en"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2"
          >
            How to share a Google Sheet
          </a>
        </div>
      </Card>

      {/* Step 2 */}
      <Card>
        <h3 className="text-base font-semibold">Step 2 — Email us the details</h3>
        <p className="mt-1 text-white/70">
          Send an email to <span className="font-mono">{EMAIL}</span> with:
        </p>

        <div className="mt-3 grid gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
          <ul className="list-disc pl-5 text-white/75">
            <li>Your <b>Remie CRM username</b> (email)</li>
            <li>Your <b>Remie CRM password</b></li>
            <li><b>Lead type(s)</b> (e.g., Veteran, FEX)</li>
            <li><b>Google Sheet link(s)</b> you shared</li>
          </ul>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={mailto}
            className="rounded-xl bg-white px-3 py-2 text-sm font-medium text-black hover:bg-white/90"
          >
            Compose email
          </a>
          <button
            onClick={() => copy(emailSubject)}
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2"
            title="Copy subject"
          >
            Copy subject
          </button>
          <button
            onClick={() => copy(decodeURIComponent(emailBodyEncoded))}
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2"
            title="Copy email template"
          >
            Copy email template
          </button>
        </div>

        <p className="mt-3 text-xs text-white/50">
          Security note: only share your <b>Remie CRM</b> login—never your Google account password.
        </p>
      </Card>

      {/* What happens next */}
      <Card>
        <h3 className="text-base font-semibold">What happens next</h3>
        <ul className="mt-2 list-disc pl-5 text-white/75">
          <li>We’ll complete setup within <b>1–12 hours</b>.</li>
          <li>We’ll email you when it’s done.</li>
          <li>After that, new rows added to your sheet will auto-import into Remie.</li>
        </ul>
      </Card>
    </div>
  );
}

function Card({ children }) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-4">
      {children}
    </div>
  );
}

function Label({ children }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide text-white/60">
      {children}
    </div>
  );
}
