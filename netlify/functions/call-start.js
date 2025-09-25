// netlify/functions/call-start.js
const fetch = require("node-fetch");
const { supaAdmin } = require("./_supa");

function e164US(s) {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s;
}
function areaCodeOf(e164) {
  const m = String(e164 || "").match(/^\+1(\d{3})\d{7}$/);
  return m ? m[1] : null;
}

async function bestFromNumber({ agent_id, lead_number }) {
  const supa = supaAdmin();
  const leadNpa = areaCodeOf(lead_number);

  // exact NPA
  if (leadNpa) {
    const { data: exact } = await supa
      .from("agent_numbers")
      .select("telnyx_number")
      .eq("agent_id", agent_id)
      .eq("area_code", leadNpa)
      .limit(1)
      .maybeSingle();
    if (exact?.telnyx_number) return exact.telnyx_number;
  }

  // closest NPA (numeric)
  const { data: all = [] } = await supa
    .from("agent_numbers")
    .select("telnyx_number,area_code")
    .eq("agent_id", agent_id);

  if (all.length) {
    if (leadNpa) {
      let best = all[0].telnyx_number;
      let bestDist = Math.abs(parseInt(all[0].area_code, 10) - parseInt(leadNpa, 10));
      for (const n of all) {
        const dist = Math.abs(parseInt(n.area_code, 10) - parseInt(leadNpa, 10));
        if (dist < bestDist) { best = n.telnyx_number; bestDist = dist; }
      }
      return best;
    }
    return all[0].telnyx_number;
  }

  // strict: must own a number
  throw new Error("You don't own any numbers yet. Please buy a number to place calls.");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const { agent_number, lead_number, agent_id, user_id, contact_id } = JSON.parse(event.body || "{}");
    if (!agent_number || !lead_number || !agent_id) {
      return { statusCode: 400, body: "agent_number, lead_number, agent_id required" };
    }

    const toAgent = e164US(agent_number);
    const toLead = e164US(lead_number);
    const fromNumber = await bestFromNumber({ agent_id, lead_number: toLead });

    const meta = {
      user_id: user_id || agent_id,
      contact_id: contact_id || null,
      agent_id,
      agent_number: toAgent,
      lead_number: toLead,
      from_number: fromNumber,
    };
    const client_state = Buffer.from(JSON.stringify(meta)).toString("base64");

    // Leg A: call the agent
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        call_control_app_id: process.env.TELNYX_CALL_CONTROL_APP_ID,
        to: toAgent,
        from: fromNumber,
        client_state,
      }),
    });
    const json = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify(json) };

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, agent_call_control_id: json.data?.call_control_id }),
    };
  } catch (e) {
    return { statusCode: 500, body: e.message || "Server error" };
  }
};
