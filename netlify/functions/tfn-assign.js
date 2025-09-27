// File: netlify/functions/tfn-assign.js
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID; // optional: auto-bind
const TELNYX_CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID;   // optional
const TELNYX_FORWARD_E164 = process.env.TELNYX_FORWARD_E164 || "";           // optional

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const user = await getUserFromRequest(event);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const supabase = getServiceClient();

    // If user already has a number, return it
    {
      const { data: existing, error: exErr } = await supabase
        .from("toll_free_numbers")
        .select("phone_number, verified, telnyx_number_id")
        .eq("assigned_to", user.id)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing?.phone_number) {
        return json({ ok: true, phone_number: existing.phone_number, verified: !!existing.verified });
      }
    }

    // Next available verified number
    const { data: candidate, error: candErr } = await supabase
      .from("toll_free_numbers")
      .select("id, phone_number, verified, telnyx_number_id")
      .is("assigned_to", null)
      .eq("verified", true)
      .limit(1)
      .maybeSingle();
    if (candErr) throw candErr;
    if (!candidate) return json({ error: "No verified numbers available. Please contact Support." }, 409);

    // Bind to Telnyx profile/forwarding (optional)
    if (TELNYX_API_KEY && candidate.telnyx_number_id && TELNYX_MESSAGING_PROFILE_ID) {
      try {
        await fetch(`https://api.telnyx.com/v2/phone_numbers/${candidate.telnyx_number_id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TELNYX_API_KEY}`,
          },
          body: JSON.stringify({
            messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
            call_forwarding: TELNYX_FORWARD_E164 ? { to: TELNYX_FORWARD_E164 } : undefined,
            call_control_app_id: TELNYX_CALL_CONTROL_APP_ID || undefined,
          }),
        });
      } catch (e) {
        console.warn("[tfn-assign] Telnyx bind warning:", e.message);
      }
    }

    // Assign to user
    const { error: updErr } = await supabase
      .from("toll_free_numbers")
      .update({ assigned_to: user.id, date_assigned: new Date().toISOString() })
      .eq("id", candidate.id);
    if (updErr) throw updErr;

    return json({ ok: true, phone_number: candidate.phone_number, verified: !!candidate.verified });
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};
