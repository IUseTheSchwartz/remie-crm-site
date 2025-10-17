// File: src/pages/SmartDialer.jsx
import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { detectDevice } from "../lib/device.js";

export default function SmartDialer() {
  const [device, setDevice] = useState("unknown");
  const [setupDone, setSetupDone] = useState(false);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  // ---------- helpers ----------
  const toE164 = (phone) => {
    const d = String(phone || "").replace(/\D+/g, "");
    if (!d) return "";
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return `+${d}`; // fallback; tel: tolerates digit-only
  };
  const humanPhone = (phone) => {
    const d = String(phone || "").replace(/\D+/g, "");
    if (d.length < 10) return phone || "—";
    const core = d.slice(-10);
    return `(${core.slice(0,3)}) ${core.slice(3,6)}-${core.slice(6)}`;
  };

  /* ---------------- Detect device type ---------------- */
  useEffect(() => {
    setDevice(detectDevice());
  }, []);

  /* ---------------- Load ALL leads for logged-in user, oldest -> newest ---------------- */
  useEffect(() => {
    async function loadLeadsAll() {
      try {
        setLoading(true);
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) {
          setLeads([]);
          setLoading(false);
          return;
        }

        // Fetch in chunks so we never miss any (no hard 50 limit).
        const PAGE_SIZE = 1000;
        let from = 0;
        let all = [];

        // Keep import order: first -> last
        // If you import without created_at, adjust to your “imported_at” column here.
        // NOTE: RLS/ownership: we keep .eq('user_id', uid)
        // If some leads were imported under a different user_id/null, they won't appear for this user.
        // (You can reassign those in the DB if needed.)
        for (;;) {
          const { data, error } = await supabase
            .from("leads")
            .select("id, name, phone, state, status, created_at")
            .eq("user_id", uid)
            .order("created_at", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

          if (error) throw error;
          const batch = data || [];
          all = all.concat(batch);
          if (batch.length < PAGE_SIZE) break; // done
          from += PAGE_SIZE;
        }

        setLeads(all);
      } catch (err) {
        console.error("Failed to load leads:", err);
        setLeads([]);
      } finally {
        setLoading(false);
      }
    }

    loadLeadsAll();
  }, []);

  /* ---------------- Setup Wizard UI ---------------- */
  if (!setupDone) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-white overflow-x-hidden">
        <h1 className="text-2xl font-semibold mb-4">📞 Smart Dialer Setup</h1>
        <p className="text-white/70 mb-6">
          Before calling leads, let’s make sure your device can place calls using your own phone number.
        </p>

        {device === "windows" && (
          <div className="bg-white/5 p-4 rounded-lg space-y-2">
            <h2 className="font-medium">🖥️ Windows Setup (Phone Link)</h2>
            <ol className="list-decimal list-inside text-white/80 space-y-1">
              <li>Open <b>Phone Link</b> on your PC.</li>
              <li>On your Android phone, open <b>Link to Windows</b>.</li>
              <li>Pair your devices using the QR code.</li>
              <li>Once linked, you’ll be able to call directly from Remie CRM.</li>
            </ol>
          </div>
        )}

        {device === "mac" && (
          <div className="bg-white/5 p-4 rounded-lg space-y-2">
            <h2 className="font-medium">🍎 Mac Setup (FaceTime / iPhone)</h2>
            <ol className="list-decimal list-inside text-white/80 space-y-1">
              <li>Sign in with the same Apple ID on both your Mac and iPhone.</li>
              <li>On your iPhone: Settings → Phone → Calls on Other Devices → Allow on Mac.</li>
              <li>On your Mac: FaceTime → Settings → Enable “Calls from iPhone.”</li>
              <li>Once linked, test calling from your browser.</li>
            </ol>
          </div>
        )}

        {device === "mobile" && (
          <div className="bg-white/5 p-4 rounded-lg">
            <p>📱 You’re all set! Calls will open directly in your phone’s dialer app.</p>
          </div>
        )}

        {device === "unknown" && (
          <div className="bg-white/5 p-4 rounded-lg">
            <p>Couldn’t detect your device. Try opening the Smart Dialer on your phone, Windows PC, or Mac.</p>
          </div>
        )}

        <button
          className="mt-6 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 px-4 py-2 rounded-lg font-medium text-white"
          onClick={() => setSetupDone(true)}
        >
          Continue to Dialer →
        </button>
      </div>
    );
  }

  /* ---------------- Main Dialer Page ---------------- */
  return (
    <div className="p-6 text-white overflow-x-hidden">
      <h1 className="text-2xl font-semibold mb-2">⚡ Smart Dialer</h1>
      <p className="text-white/70 mb-6">
        Tap a lead to call using your own phone line. Only your personal leads are displayed.
      </p>

      {loading ? (
        <div className="text-center text-white/60 py-10">Loading your leads...</div>
      ) : leads.length === 0 ? (
        <div className="text-center text-white/60 py-10">
          No leads found. Add new leads to begin calling.
        </div>
      ) : (
        <>
          {/* Mobile: Card list */}
          <div className="space-y-3 md:hidden">
            {leads.map((lead) => {
              const tel = toE164(lead.phone);
              return (
                <div
                  key={lead.id}
                  className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{lead.name || "—"}</div>
                      <div className="text-sm text-white/70 break-words">
                        {humanPhone(lead.phone)}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 text-[11px] capitalize">
                      {lead.status || "lead"}
                    </span>
                  </div>

                  <div className="mt-2 text-xs text-white/60">
                    {lead.state ? <>State: <span className="text-white/80">{lead.state}</span></> : "State: —"}
                  </div>

                  <div className="mt-4">
                    {lead.phone ? (
                      <a
                        href={`tel:${tel}`}
                        className="block w-full rounded-xl bg-gradient-to-br from-indigo-500/90 to-fuchsia-500/90 hover:from-indigo-500 hover:to-fuchsia-500 text-center font-medium py-2"
                      >
                        Call {humanPhone(lead.phone)}
                      </a>
                    ) : (
                      <span className="block w-full rounded-xl bg-white/10 text-center text-white/50 py-2">
                        No phone on file
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop / tablet: Table */}
          <div className="hidden md:block bg-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/10 text-white/80 uppercase text-xs">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Phone</th>
                  <th className="text-left px-4 py-2">State</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-t border-white/10 hover:bg-white/5">
                    <td className="px-4 py-2">{lead.name || "—"}</td>
                    <td className="px-4 py-2 font-mono">{humanPhone(lead.phone)}</td>
                    <td className="px-4 py-2">{lead.state || "—"}</td>
                    <td className="px-4 py-2 text-white/70 capitalize">{lead.status || "lead"}</td>
                    <td className="px-4 py-2">
                      {lead.phone ? (
                        <a
                          href={`tel:${toE164(lead.phone)}`}
                          className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 px-3 py-1.5 text-white text-xs font-medium"
                        >
                          Call
                        </a>
                      ) : (
                        <span className="text-white/40 text-xs">No Phone</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
