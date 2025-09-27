// Orchestrator: loads context, applies guardrails, asks the brain, sends via messages-send.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

function messagesSendUrl(event) {
  const base =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    (event?.headers && `${(event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"] || "https")}://${event.headers.host || event.headers.Host}`);
  if (!base) return null;
  return `${String(base).replace(/\/$/, "")}/.netlify/functions/messages-send`;
}

exports.handler = async (event) => {
  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { user_id, contact_id, from, to, text } = body || {};

  if (!user_id || !contact_id || !from) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: "missing_fields" }) };
  }

  // Load contact
  const { data: contact } = await db
    .from("message_contacts")
    .select("id, subscribed, ai_booked, full_name")
    .eq("id", contact_id)
    .maybeSingle();

  if (!contact || contact.subscribed === false || contact.ai_booked === true) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  // Load agent context
  const { data: agent } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url")
    .eq("user_id", user_id)
    .maybeSingle();

  // Debounce (optional): ignore if we auto-replied in last 3 minutes
  // const { data: lastOut } = await db
  //   .from("messages")
  //   .select("id, created_at, meta")
  //   .eq("user_id", user_id)
  //   .eq("to_number", from)
  //   .eq("direction", "outgoing")
  //   .order("created_at", { ascending: false })
  //   .limit(1);
  // if (lastOut?.length) { /* check timestamp & meta.sent_by_ai */ }

  // Brain
  const { decide } = require("./ai-brain");
  const out = decide({
    text,
    agentName: agent?.full_name || "your licensed broker",
    calendlyLink: agent?.calendly_url || "",
    tz: process.env.AGENT_DEFAULT_TZ || "America/Chicago",
    officeHours: { start: 9, end: 21 }, // 9am–9pm offers only
  });

  if (!out || !out.text) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  // Send via messages-send (centralizes TFN/wallet/trace)
  const sendUrl = messagesSendUrl(event);
  if (!sendUrl) {
    // fallback: store a system note so you see what would have sent
    await db.from("messages").insert([{
      user_id, contact_id, direction: "outgoing", provider: "system",
      from_number: "system", to_number: from,
      body: `[AI draft] ${out.text}`, status: "skipped",
      meta: { sent_by_ai: true, ai_intent: out.intent, ai_version: "v1" }
    }]);
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: "no_send_url" }) };
  }

  const res = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: from,
      body: out.text,
      requesterId: user_id,
      sent_by_ai: true,
    }),
  });
  const json = await res.json().catch(() => ({}));

  // Tag the message row for the UI badge
  if (json?.id) {
    try {
      await db
        .from("messages")
        .update({ meta: { sent_by_ai: true, ai_intent: out.intent, ai_version: "v1" } })
        .eq("id", json.id);
    } catch {}
  }

  // If they proposed a specific time and we confirmed, mark booked
  if (out.intent === "confirm_time") {
    await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact_id);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent: json }) };
};