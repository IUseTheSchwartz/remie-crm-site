// netlify/functions/support-ticket.js

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;

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

    // Save ticket to Supabase
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
