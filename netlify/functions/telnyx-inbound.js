// File: netlify/functions/telnyx-inbound.js
// Handles inbound messages and opt-outs

const { createClient } = require("@supabase/supabase-js");

function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || { ok: true }) };
}

exports.handler = async (event) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE, MESSAGING_OWNER_USER_ID } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

  let payload;
  try {
    const j = JSON.parse(event.body || "{}");
    payload = j?.data || j?.event || j || {};
  } catch {
    payload = {};
  }
  const eventType = payload?.event_type || payload?.type || "";
  const p = payload?.data?.payload || payload?.payload || {};
  const to0 = p?.to?.[0] || {};

  // Resolve user_id (single-tenant env var; customize if multi-tenant)
  const userId = MESSAGING_OWNER_USER_ID || null;

  // Save inbound row
  const bodyText = (p?.text || "").trim();
  const { error: insErr } = await supabase.from("messages").insert([{
    user_id: userId,
    lead_id: null,
    provider: "telnyx",
    provider_sid: p?.id || null,
    direction: "incoming",
    from_number: p?.from?.phone_number || null,
    to_number: to0?.phone_number || null,
    body: bodyText,
    status: "received",
    status_detail: JSON.stringify({ eventType, payload: p }).slice(0, 8000),
  }]);
  if (insErr) console.log("inbound insert err:", insErr?.message);

  // Update contact meta + detect STOP
  try {
    const fromE164 = (p?.from?.phone_number || "").trim();
    if (fromE164 && userId) {
      const { data: contact } = await supabase
        .from("message_contacts")
        .select("id, subscribed, meta")
        .eq("user_id", userId)
        .eq("phone", fromE164)
        .maybeSingle();

      if (contact?.id) {
        const meta = { ...(contact.meta || {}), last_incoming_at: new Date().toISOString() };
        let subscribed = contact.subscribed;

        // Opt-out keywords (case-insensitive)
        if (/\b(stop|stopall|unsubscribe|cancel|end|quit)\b/i.test(bodyText)) {
          subscribed = false;
          meta.opted_out_at = new Date().toISOString();
          // Optional: auto-reply confirmation (no wallet debit for this)
          try {
            const apiKey = process.env.TELNYX_API_KEY;
            const fromNumber = process.env.TELNYX_FROM_NUMBER;
            const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
            if (apiKey && (fromNumber || profileId)) {
              await fetch("https://api.telnyx.com/v2/messages", {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: fromE164,
                  text: "You’ve been opted out and won’t receive more texts. Reply START to opt back in.",
                  ...(profileId ? { messaging_profile_id: profileId } : { from: fromNumber }),
                }),
              }).catch(() => {});
            }
          } catch {}
        }

        await supabase.from("message_contacts").update({ subscribed, meta }).eq("id", contact.id);
      } else if (userId) {
        await supabase.from("message_contacts").insert([{
          user_id: userId,
          phone: fromE164,
          full_name: "",
          tags: [],
          subscribed: !/\b(stop|stopall|unsubscribe|cancel|end|quit)\b/i.test(bodyText),
          meta: { last_incoming_at: new Date().toISOString() },
        }]);
      }
    }
  } catch (e) {
    console.log("inbound contact update err:", e?.message);
  }

  return ok({ ok: true });
};
