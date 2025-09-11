import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const payload = body?.data?.payload || {};
    const text = payload.text;
    const fromNum = payload.from?.phone_number;
    const toNum = payload.to?.phone_number;
    const providerId = payload.id;

    if (!text || !fromNum || !toNum) {
      return { statusCode: 400, body: "Missing fields" };
    }

    const userId = process.env.DEFAULT_OWNER_USER_ID; // set this in Netlify if single-user

    const { error } = await supabase.from("messages").insert({
      user_id: userId,
      provider: "telnyx",
      direction: "in",
      from_number: fromNum,
      to_number: toNum,
      body: text,
      status: "received",
      provider_sid: providerId,
    });

    if (error) {
      console.error("inbound insert error", error);
      return { statusCode: 500, body: "DB insert failed" };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("inbound fatal", e);
    return { statusCode: 500, body: "error" };
  }
}
