import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function toE164(num) {
  const d = String(num || "").replace(/[^\d]/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(num).startsWith("+")) return String(num);
  return null;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing auth" };

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return { statusCode: 401, body: "Invalid auth" };

    const { to, body, contact_id } = JSON.parse(event.body || "{}");
    const toE = toE164(to);
    if (!toE || !body) {
      return { statusCode: 400, body: "Bad request: to (E.164) and body required" };
    }

    // Insert placeholder row
    const { data: inserted, error: insertErr } = await supabase
      .from("messages")
      .insert({
        user_id: user.id,
        contact_id,
        provider: "telnyx",
        direction: "out",
        from_number: process.env.TELNYX_FROM,
        to_number: toE,
        body,
        status: "queued",
      })
      .select()
      .single();

    if (insertErr) {
      console.error("DB insert failed", insertErr);
      return { statusCode: 500, body: "DB insert failed" };
    }

    // Send via Telnyx
    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.TELNYX_FROM,
        to: toE,
        text: body,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE,
      }),
    });

    const telnyx = await resp.json();

    if (!resp.ok) {
      console.error("Telnyx send failed", telnyx);
      await supabase
        .from("messages")
        .update({ status: "failed" })
        .eq("id", inserted.id);
      return { statusCode: 502, body: "Telnyx send failed" };
    }

    await supabase
      .from("messages")
      .update({
        provider_sid: telnyx.data?.id,
        status: telnyx.data?.to[0]?.status || "sending",
      })
      .eq("id", inserted.id);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("send fatal", e);
    return { statusCode: 500, body: "Server error" };
  }
}
