// netlify/functions/messages-send.js  (Telnyx edition)
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

// ---- ENV you must set in Netlify ----
// TELNYX_API_KEY=KEYxxxxxxxxxxxxxxxx
// TELNYX_MESSAGING_PROFILE=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
// TELNYX_FROM=+18885551234  (your TFN or 10DLC)
// SUPABASE_URL=...
// SUPABASE_SERVICE_ROLE_KEY=...
// COST_PER_SEGMENT_CENTS=1  (optional)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

const COST = parseInt(process.env.COST_PER_SEGMENT_CENTS || "1", 10);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    // Auth (same pattern you already use)
    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing auth" };

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return { statusCode: 401, body: "Invalid auth" };

    const { to, body, contact_id } = JSON.parse(event.body || "{}");
    if (!to || !body) return { statusCode: 400, body: "to and body required" };

    // Wallet check (same behavior)
    const { data: wallet } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!wallet || wallet.balance_cents < COST) {
      return { statusCode: 402, body: "Insufficient balance" };
    }

    await supabase.from("user_wallets")
      .update({ balance_cents: wallet.balance_cents - COST })
      .eq("user_id", user.id);

    // ---- Send via Telnyx v2 Messages API ----
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.TELNYX_FROM,
        to,
        text: body,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE,
        // delivery status webhooks configured at the Messaging Profile level
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("[telnyx send error]", data);
      return { statusCode: 502, body: "Telnyx send failed" };
    }

    const telnyxId = data.data?.id || data.id;

    // Save message record (keep your existing schema shape)
    await supabase.from("messages").insert({
      user_id: user.id,
      contact_id: contact_id || null,
      provider: "telnyx",
      direction: "out",
      from_number: process.env.TELNYX_FROM,
      to_number: to,
      body,
      status: "queued",
      provider_sid: telnyxId,
      segments: 1,
      price_cents: COST,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: telnyxId }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Send failed" };
  }
};
