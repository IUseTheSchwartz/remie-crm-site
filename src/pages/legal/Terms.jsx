// File: src/pages/legal/Terms.jsx
import React from "react";
import { Link } from "react-router-dom";

const BRAND = "Remie CRM";
const CONTACT = "support@remiecrm.com";
const EFFECTIVE = "September 2, 2025";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-semibold">Terms of Service</h1>
        <p className="mt-2 text-sm text-white/60">Effective {EFFECTIVE}</p>

        <p className="mt-6 text-white/80">
          These Terms of Service (“Terms”) govern your access to and use of {BRAND}, including our website, web application, and related services (collectively, the “Service”). By using the Service, you agree to these Terms.
        </p>

        <h2 className="mt-8 text-xl font-semibold">1. Who we are</h2>
        <p className="mt-2 text-white/80">
          {BRAND} is a CRM platform for insurance professionals that provides tools for lead management, messaging, scheduling, and light automation.
        </p>

        <h2 className="mt-8 text-xl font-semibold">2. Eligibility & accounts</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li>You must be at least 18 years old and capable of forming a binding contract.</li>
          <li>You’re responsible for safeguarding your login credentials and any activity on your account.</li>
          <li>You must provide accurate information and keep it current.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">3. Subscriptions, credits & billing</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li>Paid features may require a subscription (handled via Stripe) and/or message credits. Prices are shown before purchase.</li>
          <li>Credits may be consumed for SMS/MMS and other metered features; usage may vary by carrier and destination.</li>
          <li>Except where required by law, all purchases are final and non-refundable.</li>
          <li>You authorize us and our payment processor (Stripe) to charge the payment method on file for recurring fees until you cancel.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">4. Messaging compliance (important)</h2>
        <p className="mt-2 text-white/80">
          You are solely responsible for your outbound communications and compliance with applicable laws, regulations, and carrier policies (including, without limitation, the Telephone Consumer Protection Act (TCPA), CAN-SPAM, CTIA guidelines, and any state-specific rules). You must obtain valid consent from recipients before sending promotional or automated messages and must honor opt-out requests promptly. You must not send illegal, fraudulent, or abusive content.
        </p>
        <p className="mt-2 text-white/80">
          By providing your phone number and replying YES to confirm opt-in, you consent to receive SMS reminders and updates from {BRAND}. Frequency is typically 2–3 messages per week depending on account activity. Message and data rates may apply. Reply STOP to unsubscribe at any time, or HELP for help.
        </p>

        <h2 className="mt-8 text-xl font-semibold">5. Acceptable use</h2>
        <ul className="mt-2 list-disc pl-5 text-white/80 space-y-2">
          <li>No unlawful, harmful, deceptive, or infringing activity.</li>
          <li>No spam or unsolicited messages without proper consent.</li>
          <li>No attempts to reverse engineer, scrape at scale, or disrupt the Service.</li>
          <li>No storage or transmission of content that violates third-party rights.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">6. Data & privacy</h2>
        <p className="mt-2 text-white/80">
          Our <Link to="/legal/privacy" className="underline">Privacy Policy</Link> explains how we collect, use, and share information. By using the Service, you consent to our data practices as described there.
        </p>

        <h2 className="mt-8 text-xl font-semibold">7. Third-party services</h2>
        <p className="mt-2 text-white/80">
          We rely on third-party providers (e.g., Netlify for hosting, Supabase for auth/database, Stripe for payments, and Resend for email). Their services are subject to their own terms and policies. We are not responsible for third-party outages or changes.
        </p>

        <h2 className="mt-8 text-xl font-semibold">8. Service changes & availability</h2>
        <p className="mt-2 text-white/80">
          We may update or discontinue features at any time. We strive for high availability but do not guarantee the Service will be uninterrupted or error-free.
        </p>

        <h2 className="mt-8 text-xl font-semibold">9. Termination</h2>
        <p className="mt-2 text-white/80">
          You may stop using the Service at any time. We may suspend or terminate your access if you violate these Terms or create risk/harm. Upon termination, your right to use the Service ceases immediately; certain clauses (e.g., disclaimers, limits of liability) survive termination.
        </p>

        <h2 className="mt-8 text-xl font-semibold">10. Disclaimers</h2>
        <p className="mt-2 text-white/80">
          The Service is provided “as is” and “as available” without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will meet your requirements or be uninterrupted, secure, or error-free.
        </p>

        <h2 className="mt-8 text-xl font-semibold">11. Limitation of liability</h2>
        <p className="mt-2 text-white/80">
          To the maximum extent permitted by law, {BRAND} and its affiliates will not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, or goodwill, resulting from (a) your use of or inability to use the Service; (b) any unauthorized access, use, or alteration of your transmissions or content; or (c) any third-party conduct or content. Our total liability for any claim relating to the Service is limited to the amounts you paid us in the 12 months preceding the event giving rise to the claim.
        </p>

        <h2 className="mt-8 text-xl font-semibold">12. Indemnification</h2>
        <p className="mt-2 text-white/80">
          You agree to defend, indemnify, and hold harmless {BRAND} from and against any claims, liabilities, damages, losses, and expenses (including reasonable attorneys’ fees) arising from your use of the Service, your content, or your violation of these Terms or applicable law.
        </p>

        <h2 className="mt-8 text-xl font-semibold">13. Governing law; disputes</h2>
        <p className="mt-2 text-white/80">
          These Terms are governed by the laws of the State of Tennessee, without regard to conflict-of-law principles. Any dispute will be resolved in the state or federal courts located in Tennessee, and you consent to their jurisdiction.
        </p>

        <h2 className="mt-8 text-xl font-semibold">14. Changes to these Terms</h2>
        <p className="mt-2 text-white/80">
          We may modify these Terms from time to time. Material changes will be indicated by updating the “Effective” date above and, when appropriate, by additional notice. Your continued use of the Service after changes become effective constitutes acceptance.
        </p>

        <h2 className="mt-8 text-xl font-semibold">15. Contact</h2>
        <p className="mt-2 text-white/80">
          Questions about these Terms? Contact us at <a href={`mailto:${CONTACT}`} className="underline">{CONTACT}</a>.
        </p>
      </div>
    </div>
  );
}
