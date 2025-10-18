// File: src/pages/SmartDialer.jsx
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { detectDevice } from "../lib/device.js";

export default function SmartDialer() {
  const [device, setDevice] = useState("unknown");
  const [setupDone, setSetupDone] = useState(false);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  // ---------- search UI state ----------
  const [tempQ, setTempQ] = useState("");
  const [q, setQ] = useState("");
  const [selectedState, setSelectedState] = useState("");

  // ---------- dial tracking ----------
  const [dialsToday, setDialsToday] = useState(0);

  // Apple-only capability for FaceTime Audio
  const isFaceTimeCapable = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = (navigator.userAgent || "").toLowerCase();
    return /iphone|ipad|ipod|macintosh|mac os x/.test(ua);
  }, []);

  // ---------- helpers ----------
  const toE164 = (phone) => {
    const d = String(phone || "").replace(/\D+/g, "");
    if (!d) return "";
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return `+${d}`;
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

        const PAGE_SIZE = 1000;
        let from = 0;
        let all = [];

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
          if (batch.length < PAGE_SIZE) break;
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

  /* ---------------- Fetch today's dial count ---------------- */
  useEffect(() => {
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const jwt = sess?.session?.access_token || null;
        const res = await fetch("/.netlify/functions/track-dial", {
          method: "GET",
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && Number.isFinite(j.count)) setDialsToday(j.count);
      } catch (e) {
        console.warn("dial count fetch failed", e);
      }
    })();
  }, []);

  // ---------- derived: state list + filtered results ----------
  const availableStates = useMemo(() => {
    const s = new Set();
    for (const lead of leads) {
      const st = String(lead.state || "").trim();
      if (st) s.add(st);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [leads]);

  const filteredLeads = useMemo(() => {
    if (!q && !selectedState) return leads;

    const qDigits = q.replace(/\D+/g, "");
    const qLower = q.toLowerCase().trim();

    return leads.filter((lead) => {
      if (selectedState && String(lead.state || "") !== selectedState) return false;

      if (!qLower) return true;

      const name = String(lead.name || "").toLowerCase();
      const st = String(lead.state || "").toLowerCase();
      const phoneDigits = String(lead.phone || "").replace(/\D+/g, "");

      return (
        name.includes(qLower) ||
        st.includes(qLower) ||
        (qDigits && phoneDigits.includes(qDigits))
      );
    });
  }, [leads, q, selectedState]);

  /* ---------------- dial recorder (sendBeacon/keepalive) ---------------- */
  async function recordDial(lead, method) {
    try {
      const payload = {
        lead_id: lead?.id || null,
        phone: toE164(lead?.phone),
        method, // "tel" | "facetime"
      };

      // Try to include JWT (helps if Authorization header is dropped by iOS)
      const { data: sess } = await supabase.auth.getSession();
      const jwt = sess?.session?.access_token || "";
      const body = JSON.stringify(jwt ? { ...payload, jwt } : payload);

      // Prefer sendBeacon so it survives the page leaving for tel:/facetime:
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        const ok = navigator.sendBeacon("/.netlify/functions/track-dial", blob);
        if (!ok) {
          // Fallback
          await fetch("/.netlify/functions/track-dial", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          });
        }
      } else {
        await fetch("/.netlify/functions/track-dial", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
      }

      // Optimistic local bump so UI feels instant
      setDialsToday((n) => n + 1);
    } catch (e) {
      console.warn("recordDial failed", e);
    }
  }

  /* ---------------- Setup Wizard UI ---------------- */
  if (!setupDone) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-white overflow-x-hidden">
        <h1 className="text-2xl font-semibold mb-1">📞 Smart Dialer Setup</h1>

        <div className="text-sm text-white/70 mb-4">
          <span className="inline-block rounded-lg bg-white/10 px-2 py-1">
            Dials today: <b>{dialsToday}</b>
          </span>
        </div>

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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold mb-1">⚡ Smart Dialer</h1>
          <p className="text-white/70">
            Tap a lead to call using your own phone line. Only your personal leads are displayed.
          </p>
        </div>
        <div className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-sm">
          Dials today: <b>{dialsToday}</b>
        </div>
      </div>

      {/* Search / filter bar */}
      <div className="mt-4 mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-3">
          <div className="flex-1 flex items-center gap-2">
            <input
              value={tempQ}
              onChange={(e) => setTempQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setQ(tempQ); }}
              placeholder="Search name, phone, or state…"
              className="flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
            />
            <button
              onClick={() => setQ(tempQ)}
              className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
            >
              Search
            </button>
            {(q || selectedState) && (
              <button
                onClick={() => { setTempQ(""); setQ(""); setSelectedState(""); }}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-white/60">State:</label>
            <select
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
              className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/40"
            >
              <option value="">All</option>
              {availableStates.map((st) => (
                <option value={st} key={st}>{st}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-2 text-[11px] text-white/50">
          Showing {filteredLeads.length} of {leads.length} lead{leads.length === 1 ? "" : "s"}
          {q ? <> (filtered by “{q}”)</> : null}
          {selectedState ? <> {q ? "and" : ""} state “{selectedState}”</> : null}
        </div>
      </div>

      {loading ? (
        <div className="text-center text-white/60 py-10">Loading your leads...</div>
      ) : filteredLeads.length === 0 ? (
        <div className="text-center text-white/60 py-10">
          No leads found with your current filters.
        </div>
      ) : (
        <>
          {/* Mobile: Card list */}
          <div className="space-y-3 md:hidden">
            {filteredLeads.map((lead) => {
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

                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {lead.phone ? (
                      <>
                        <a
                          href={`tel:${tel}`}
                          onMouseDown={() => recordDial(lead, "tel")}
                          onTouchStart={() => recordDial(lead, "tel")}
                          className="block w-full rounded-xl bg-gradient-to-br from-indigo-500/90 to-fuchsia-500/90 hover:from-indigo-500 hover:to-fuchsia-500 text-center font-medium py-2"
                        >
                          Call {humanPhone(lead.phone)}
                        </a>
                        {isFaceTimeCapable && (
                          <a
                            href={`facetime-audio://${tel}`}
                            onMouseDown={() => recordDial(lead, "facetime")}
                            onTouchStart={() => recordDial(lead, "facetime")}
                            className="block w-full rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-center font-medium py-2"
                          >
                            FaceTime Audio
                          </a>
                        )}
                      </>
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
                {filteredLeads.map((lead) => {
                  const tel = toE164(lead.phone);
                  return (
                    <tr key={lead.id} className="border-t border-white/10 hover:bg-white/5">
                      <td className="px-4 py-2">{lead.name || "—"}</td>
                      <td className="px-4 py-2 font-mono">{humanPhone(lead.phone)}</td>
                      <td className="px-4 py-2">{lead.state || "—"}</td>
                      <td className="px-4 py-2 text-white/70 capitalize">{lead.status || "lead"}</td>
                      <td className="px-4 py-2">
                        {lead.phone ? (
                          <div className="flex items-center gap-2">
                            <a
                              href={`tel:${tel}`}
                              onMouseDown={() => recordDial(lead, "tel")}
                              onTouchStart={() => recordDial(lead, "tel")}
                              className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 px-3 py-1.5 text-white text-xs font-medium"
                            >
                              Call
                            </a>
                            {isFaceTimeCapable && (
                              <a
                                href={`facetime-audio://${tel}`}
                                onMouseDown={() => recordDial(lead, "facetime")}
                                onTouchStart={() => recordDial(lead, "facetime")}
                                className="inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                              >
                                FaceTime Audio
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="text-white/40 text-xs">No Phone</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
