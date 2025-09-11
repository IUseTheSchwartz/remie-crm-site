// File: src/pages/PrietoInsurance.jsx
import { Mail, Phone, MapPin } from "lucide-react";

export default function PrietoInsurance() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-500 via-purple-500 to-fuchsia-500 text-white px-6 py-12">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-4xl font-bold mb-6">
          About Prieto Insurance Solutions LLC
        </h1>

        <p className="mb-4 text-lg leading-relaxed">
          Prieto Insurance Solutions LLC is a licensed life insurance brokerage
          based in Clarksville, Tennessee. We help families secure affordable
          coverage including Final Expense, Whole Life, and Indexed Universal
          Life (IUL) products. Our mission is to provide clear, personalized
          insurance solutions that protect what matters most.
        </p>

        <p className="mb-4 text-lg leading-relaxed">
          As a trusted partner, we work with leading carriers to ensure our
          clients have access to quality policies that fit their needs and
          budget. Every client inquiry is treated with care, and all SMS
          communication is limited to appointment confirmations, policy
          information, and service updates for individuals who have explicitly
          requested information.
        </p>

        <div className="bg-white/10 rounded-xl p-6 mt-8 shadow-lg">
          <h2 className="text-2xl font-semibold mb-4">Business Information</h2>
          <ul className="space-y-3 text-lg">
            <li className="flex items-center gap-3">
              <MapPin className="w-5 h-5" />
              940 Rossview Rd, Clarksville, TN 37043
            </li>
            <li className="flex items-center gap-3">
              <Phone className="w-5 h-5" />
              (915) 494-3286
            </li>
            <li className="flex items-center gap-3">
              <Mail className="w-5 h-5" />
              JacobPrieto@gmail.com
            </li>
          </ul>
        </div>

        <div className="bg-white/10 rounded-xl p-6 mt-8 shadow-lg">
          <h2 className="text-2xl font-semibold mb-4">Privacy & Opt-Out</h2>
          <p className="leading-relaxed">
            We respect your privacy. Clients who submit their information via
            lead forms or appointment requests may receive SMS communications
            related to their inquiry. You may opt out at any time by replying
            STOP to any message. For further assistance, reply HELP or contact
            us directly.
          </p>
        </div>

        <footer className="mt-12 text-center text-sm text-white/70">
          © {new Date().getFullYear()} Prieto Insurance Solutions LLC. All rights reserved.
        </footer>
      </div>
    </div>
  );
}
