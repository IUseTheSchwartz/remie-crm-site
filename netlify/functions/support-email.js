// File: netlify/functions/support-email.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// Required env vars:
// - RESEND_API_KEY
// - SUPPORT_TO_EMAIL  (where you receive messages)
// - SUPPORT_FROM_EMAIL (verified sender, e.g. support@yourdomain.com)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name = "", email = "", phone = "", reason = "" } = req.body || {};
    if (!name || !email || !reason) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const to = process.env.SUPPORT_TO_EMAIL;
    const from = process.env.SUPPORT_FROM_EMAIL;
    if (!to || !from) {
      return res.status(500).json({ error: "Email not configured." });
    }

    const subject = `CRM Support: ${name} (${email})`;
    const html = `
      <div style="font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.5">
        <h2>New Support Request</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(phone)}</p>
        <p><strong>Reason:</strong></p>
        <pre style="white-space:pre-wrap">${escapeHtml(reason)}</pre>
      </div>
    `;

    await resend.emails.send({
      from,
      to,
      subject,
      html,
      reply_to: email, // so you can reply directly
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to send email." });
  }
}

// Basic escaping to avoid HTML injection
function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
