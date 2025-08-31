// File: src/pages/ToolsPage.jsx
import { Search, Calculator, Globe, Phone, ShieldCheck } from "lucide-react";

function open(url) {
  if (!url) return alert("No URL configured for this tool yet.");
  window.open(url, "_blank", "noopener,noreferrer");
}

function ToolCard({ icon: Icon, title, desc, onClick }) {
  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-2xl border border-white/10 bg-black/30 p-4 hover:bg-white/[0.04] transition shadow-[0_0_0_1px_rgba(255,255,255,0.06)_inset]"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
          <Icon className="h-5 w-5 text-white/80" />
        </div>
        <div>
          <div className="font-medium text-white">{title}</div>
          <div className="mt-1 text-sm text-white/60">{desc}</div>
        </div>
      </div>
    </button>
  );
}

export default function ToolsPage() {
  // Read from Netlify env variables
  const QUOTE_URL = import.meta.env.VITE_QUOTE_TOOL_URL || "";
  const CARRIER_DIR_URL = import.meta.env.VITE_CARRIER_DIRECTORY_URL || "";

  const tools = [
    {
      title: "FastPeopleSearch",
      desc: "Quickly look up phones, addresses, and relatives.",
      icon: Search,
      onClick: () => open("https://www.fastpeoplesearch.com/"),
    },
    {
      title: "Quote Tool",
      desc: "Open your carrier/aggregator quote tool.",
      icon: Calculator,
      onClick: () => open(QUOTE_URL),
    },
    {
      title: "ZIP → Time Zone",
      desc: "Find the local time before dialing.",
      icon: Globe,
      onClick: () => open("https://www.timeanddate.com/worldclock/usa"),
    },
    {
      title: "BMI Calculator",
      desc: "Estimate rating class quickly.",
      icon: ShieldCheck,
      onClick: () => open("https://www.calculator.net/bmi-calculator.html"),
    },
    {
      title: "Carrier Phone Directory",
      desc: "Your master carrier support phone list.",
      icon: Phone,
      onClick: () => open(CARRIER_DIR_URL),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xl font-semibold">Tools</div>
        <div className="text-white/60 text-sm">Quick-access utilities for daily production.</div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((t) => (
          <ToolCard key={t.title} {...t} />
        ))}
      </div>
    </div>
  );
}
