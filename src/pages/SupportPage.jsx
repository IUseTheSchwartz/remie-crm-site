// File: src/pages/SupportPage.jsx
import { useMemo, useState } from "react";

export default function SupportPage() {
  // Prefer env var; fall back to a placeholder so dev builds don't break
  const INVITE = useMemo(
    () => import.meta.env?.VITE_DISCORD_INVITE_URL || "https://discord.gg/rJsqYxHUVM",
    []
  );

  const [copied, setCopied] = useState(false);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(INVITE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; no toast needed
    }
  }

  // Deep link for native app (optional). Web link still works everywhere.
  const deepLink = useMemo(() => {
    try {
      const url = new URL(INVITE);
      // discord.gg/<code> or discord.com/invite/<code>
      const code =
        url.hostname.includes("discord.gg")
          ? url.pathname.replace("/", "")
          : url.pathname.split("/").pop();
      return code ? `discord://invite/${code}` : INVITE;
    } catch {
      return INVITE;
    }
  }, [INVITE]);

  return (
    <div className="max-w-3xl mx-auto p-6 text-white">
      <h1 className="text-2xl font-semibold mb-3">Support</h1>

      <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
        <div className="text-lg font-medium mb-1">We’ve moved support to Discord</div>
        <p className="text-white/70">
          All support and community help now live in our Discord. Join the server to
          ask questions, get updates, and chat with the team.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a
            href={INVITE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-xl bg-white text-black px-4 py-2 font-medium hover:bg-white/90"
          >
            Join now
          </a>

          {/* Optional: try to open native app first */}
          <a
            href={deepLink}
            className="inline-flex items-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
          >
            Open in Discord app
          </a>

          <button
            type="button"
            onClick={copyInvite}
            className="inline-flex items-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
          >
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        </div>

        <div className="mt-4 text-xs text-white/50">
          Tip: if the button doesn’t work on your device, copy the link and open it in
          your browser or the Discord app.
        </div>
      </div>
    </div>
  );
}
