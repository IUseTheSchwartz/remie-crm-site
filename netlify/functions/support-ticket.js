// netlify/functions/support-ticket.js
import { ServerClient } from "postmark";

// Node 18+ has global fetch; Netlify uses Node 20 per your netlify.toml

const {
  POSTMARK_SERVER_TOKEN,
  SUPPORT_FROM_EMAIL,
  SUPPORT_TO_EMAIL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
} = process.env;

const postmark = new ServerClient(POSTMARK_SERVER_TOKEN);

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const {
      user_id = null,
      name = "",
      email = "",
      subject = "",
      message = "",
      severity = "normal",
      path = "",
      meta = {},
    } = payload;

    // 1) Save to Supabase (via PostgREST)
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/support_tickets`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id,
        name,
        email,
        subject,
        message,
        severity,
        path,
        meta,
        status: "open",
      }),
    });

    if (!insertRes.ok) {
      const text = await insertRes.text();
      throw new Error(`Supabase insert failed: ${insertRes.status} ${text}`);
    }
    const [ticket] = await insertRes.json();

    // 2) Email notification (optional—skips if missing envs)
    if (POSTMARK_SERVER_TOKEN && SUPPORT_FROM_EMAIL && SUPPORT_TO_EMAIL) {
      await postmark.sendEmail({
        From: SUPPORT_FROM_EMAIL,
        To: SUPPORT_TO_EMAIL,
        MessageStream: "outbound",
        ReplyTo: email || SUPPORT_FROM_EMAIL,
        Subject: `[Support] ${subject || "(no subject)"} • ${severity}`,
        TextBody:
`New support ticket

ID: ${ticket.id}
Severity: ${severity}
From: ${name} <${email}>
Path: ${path}

Message:
${message}

Meta:
${JSON.stringify(meta, null, 2)}
`,
        HtmlBody:
`<h2>New support ticket</h2>
<p><b>ID:</b> ${ticket.id}</p>
<p><b>Severity:</b> ${severity}</p>
<p><b>From:</b> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
<p><b>Path:</b> ${escapeHtml(path || "-")}</p>
<p><b>Message:</b></p>
<pre>${escapeHtml(message || "")}</pre>
<p><b>Meta:</b></p>
<pre>${escapeHtml(JSON.stringify(meta || {}, null, 2))}</pre>`,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ticket }),
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
