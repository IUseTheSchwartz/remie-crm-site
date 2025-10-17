// File: src/pages/SmartDialer.jsx
import { useState, useEffect } from "react";
import { detectDevice } from "../lib/device.js"; // optional helper if you create it

export default function SmartDialer() {
  const [device, setDevice] = useState("unknown");
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    setDevice(detectDevice());
  }, []);

  if (!setupDone) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">📞 Smart Dialer Setup</h1>
        {device === "windows" && (
          <div className="bg-white/5 p-4 rounded-lg space-y-2">
            <h2 className="font-medium">Windows Setup (Phone Link)</h2>
            <ol className="list-decimal list-inside text-white/80 space-y-1">
              <li>Open <b>Phone Link</b> on your PC.</li>
              <li>On your Android, open <b>Link to Windows</b>.</li>
              <li>Pair your devices using the QR code.</li>
              <li>Once linked, calls from Remie CRM will use your phone.</li>
            </ol>
          </div>
        )}
        {device === "mac" && (
          <div className="bg-white/5 p-4 rounded-lg space-y-2">
            <h2 className="font-medium">Mac Setup (FaceTime / iPhone)</h2>
            <ol className="list-decimal list-inside text-white/80 space-y-1">
              <li>Use the same Apple ID on both Mac and iPhone.</li>
              <li>On iPhone: Settings → Phone → Calls on Other Devices → Allow on Mac.</li>
              <li>On Mac: FaceTime → Preferences → Enable “Calls from iPhone”.</li>
              <li>Once linked, test calling from your browser.</li>
            </ol>
          </div>
        )}
        {device === "mobile" && (
          <div className="bg-white/5 p-4 rounded-lg">
            <p>Your phone is ready. Calls will open directly in your dialer app.</p>
          </div>
        )}
        {device === "unknown" && (
          <div className="bg-white/5 p-4 rounded-lg">
            <p>Couldn’t detect your device. Please try on a phone, Windows PC, or Mac.</p>
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

  // --- After setup complete ---
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">📞 Smart Dialer</h1>
      <p className="text-white/70 mb-6">
        Click a lead’s number below to start a call using your own phone number.
      </p>

      <div className="bg-white/5 rounded-xl overflow-hidden">
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
            {[
              { name: "John Smith", phone: "+16155552039", state: "TN", status: "New Lead" },
              { name: "Maria Lopez", phone: "+12145558811", state: "TX", status: "No Answer" },
            ].map((lead) => (
              <tr key={lead.phone} className="border-t border-white/10">
                <td className="px-4 py-2">{lead.name}</td>
                <td className="px-4 py-2">{lead.phone}</td>
                <td className="px-4 py-2">{lead.state}</td>
                <td className="px-4 py-2 text-white/70">{lead.status}</td>
                <td className="px-4 py-2">
                  <a
                    href={`tel:${lead.phone}`}
                    className="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 px-3 py-1.5 rounded-lg text-white text-xs font-medium"
                  >
                    Call
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
