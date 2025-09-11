// File: src/pages/legal/Privacy.jsx
import React from "react";
import { Link } from "react-router-dom";

const BRAND = "Remie CRM";
const CONTACT = "support@remiecrm.com";
const EFFECTIVE = "September 2, 2025";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-semibold">Privacy Policy</h1>
        <p className="mt-2 text-sm text-white/60">Effective {EFFECTIVE}</p>

        <p className="mt-6 text-white/80">
          This Privacy Policy explains how {BRAND} (“we,” “us,” or “our”) collects, uses, and shares information when you use our website and services (the “Service”).
        </p>

        <h2 className="mt-8 text-xl font-semibold">1. Information we collect</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li><span className="font-medium">Account data</span>: email, name, and settings you provide when creating or using your account.</li>
          <li><span className="font-medium">Leads & contacts</span>: information you import or create (e.g., names, phone numbers, emails, notes, state/license info).</li>
          <li><span className="font-medium">Communications</span>: messages you send via the Service (subject to your compliance obligations), support requests, and replies.</li>
          <li><span className="font-medium">Billing</span>: limited payment details handled by our processor (Stripe). We do not store full card numbers.</li>
          <li><span className="font-medium">Usage</span>: logs, device type, browser, pages viewed, referring URLs, approximate location, and similar analytics.</li>
          <li><span className="font-medium">Cookies</span>: to keep you signed in, remember preferences, and measure performance.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">2. How we use information</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li>Provide, maintain, and improve the Service.</li>
          <li>Process payments, manage subscriptions, and allocate credits.</li>
          <li>Send transactional communications (e.g., receipts, account notices) and respond to support requests.</li>
          <li>Secure our systems, prevent abuse, and comply with law.</li>
          <li>Analyze usage and develop new features.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">3. How we share information</h2>
        <p className="mt-2 text-white/80">
          We share information with service providers who help us operate the Service, subject to appropriate safeguards:
        </p>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li><span className="font-medium">Hosting & infrastructure</span>: Netlify (hosting/functions), Supabase (authentication/database), object storage if used.</li>
          <li><span className="font-medium">Payments</span>: Stripe processes your payments and may retain related data.</li>
          <li><span className="font-medium">Email</span>: Resend for transactional/support emails you request.</li>
          <li>Law enforcement or legal requests where required by law.</li>
          <li>Business transfers (e.g., merger, acquisition) consistent with this Policy.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">4. SMS/MMS and email compliance</h2>
        <p className="mt-2 text-white/80">
          If you use messaging features, you must obtain appropriate consent from recipients and honor opt-outs. You are responsible for the content of your messages and for compliance with TCPA, CAN-SPAM, CTIA guidelines, and applicable state laws.
        </p>
        <p className="mt-2 text-white/80">
          By providing your phone number and opting in, you consent to receive SMS messages from {BRAND}. Message frequency may vary, typically 2–3 messages per week depending on account activity. Message and data rates may apply. You can opt out at any time by replying STOP, or get help by replying HELP.
        </p>

        <h2 className="mt-8 text-xl font-semibold">5. Data retention</h2>
        <p className="mt-2 text-white/80">
          We retain information as long as necessary to provide the Service, comply with legal obligations, resolve disputes, and enforce agreements. You may request deletion of your account data; some records may be retained as required by law or for legitimate business purposes.
        </p>

        <h2 className="mt-8 text-xl font-semibold">6. Security</h2>
        <p className="mt-2 text-white/80">
          We implement reasonable technical and organizational measures to protect information. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.
        </p>

        <h2 className="mt-8 text-xl font-semibold">7. International transfers</h2>
        <p className="mt-2 text-white/80">
          Our providers may process data in the United States and other countries. By using the Service, you consent to such transfers.
        </p>

        <h2 className="mt-8 text-xl font-semibold">8. Children’s privacy</h2>
        <p className="mt-2 text-white/80">
          The Service is not directed to children under 13, and we do not knowingly collect personal information from them. If you believe a child has provided us personal information, contact us and we will take appropriate action.
        </p>

        <h2 className="mt-8 text-xl font-semibold">9. Your choices & rights</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li>You may update profile details in your account.</li>
          <li>You can request access, correction, or deletion of personal information by emailing <a href={`mailto:${CONTACT}`} className="underline">{CONTACT}</a>.</li>
          <li>You can control cookies via your browser; disabling cookies may affect functionality.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">10. State & regional notices</h2>
        <p className="mt-2 text-white/80">
          Depending on your location, you may have additional rights under laws like the CCPA/CPRA (California) or GDPR (EU). To exercise applicable rights, contact us at <a href={`mailto:${CONTACT}`} className="underline">{CONTACT}</a>.
        </p>

        <h2 className="mt-8 text-xl font-semibold">11. Changes to this Policy</h2>
        <p className="mt-2 text-white/80">
          We may update this Policy occasionally. Material changes will be indicated by updating the “Effective” date above and, when appropriate, additional notice. Your continued use of the Service after changes take effect constitutes acceptance.
        </p>

        <h2 className="mt-8 text-xl font-semibold">12. Contact</h2>
        <p className="mt-2 text-white/80">
          Questions about privacy? Email us at <a href={`mailto:${CONTACT}`} className="underline">{CONTACT}</a>.
        </p>

        <div className="mt-8 text-white/60 text-sm">
          See also our <Link to="/legal/terms" className="underline">Terms of Service</Link>.
        </div>
      </div>
    </div>
  );
}
