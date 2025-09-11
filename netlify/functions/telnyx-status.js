import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const data = body?.data || {};
    const p = data.payload || {};
    const id = p.id || p.message_id;
    const status = p.status || p.to?.[0]?.status || data?.event_type || "unknown";

    if (!id) return { statusCode: 200, body: "no id" };

    const { error } = await supabase
      .from("messages")
      .update({ status })
      .eq("provider_sid", id);

    if (error) {
      console.error("status update error", error);
      return { statusCode: 500, body: "DB update failed" };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("status fatal", e);
    return { statusCode: 200, body: "ok" }; // Telnyx retries if 5xx
  }
}
