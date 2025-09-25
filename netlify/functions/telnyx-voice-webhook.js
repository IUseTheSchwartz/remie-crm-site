// netlify/functions/telnyx-voice-webhook.js
const fetch = require("node-fetch");
const { supaAdmin } = require("./_supa");
const TX = "https://api.telnyx.com/v2";

function tx(method, path, body) {
  return fetch(`${TX}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function parseState(b64) {
  try { return JSON.parse(Buffer.from(String(b64 || ""), "base64").toString("utf8")); }
  catch { return {}; }
}
const ok = (obj = { ok: true }) => ({ statusCode: 200, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const payload = JSON.parse(event.body || "{}");
  const data = payload?.data || {};
  const type = data?.event_type;
  const p = data?.payload || {};
  const callId = p.call_control_id;
  const clientState = parseState(p.client_state);
  const supa = supaAdmin();

  async function ensureLog(status) {
    if (!callId) return;
    const { data: existing } = await supa
      .from("call_logs")
      .select("id")
      .eq("telnyx_leg_a_id", callId)
      .limit(1);
    if (!existing?.length) {
      await supa.from("call_logs").insert({
        user_id: clientState.user_id || null,
        contact_id: clientState.contact_id || null,
        to_number: clientState.lead_number,
        from_number: clientState.from_number,
        agent_number: clientState.agent_number,
        telnyx_leg_a_id: callId,
        status,
      });
    } else if (status) {
      await supa.from("call_logs").update({ status }).eq("telnyx_leg_a_id", callId);
    }
  }

  if (type === "call.ringing") {
    await ensureLog("ringing");
    return ok();
  }

  // Agent leg answered → dial the lead (auto-bridges when connected)
  if (type === "call.answered" && p.direction === "outbound" && clientState?.lead_number) {
    await ensureLog("answered");
    await tx("POST", `/calls/${callId}/actions/dial`, {
      to: clientState.lead_number,
      from: clientState.from_number,
      timeout_secs: 45,
    });
    return ok();
  }

  if (type === "call.hangup") {
    await supa
      .from("call_logs")
      .update({ status: "completed", ended_at: new Date().toISOString() })
      .or(`telnyx_leg_a_id.eq.${callId},telnyx_leg_b_id.eq.${callId}`);
    return ok();
  }

  if (type === "call.recording.saved") {
    const url = p?.recording_urls?.[0];
    if (url) {
      await supa
        .from("call_logs")
        .update({ recording_url: url })
        .or(`telnyx_leg_a_id.eq.${callId},telnyx_leg_b_id.eq.${callId}`);
    }
    return ok();
  }

  return ok();
};
