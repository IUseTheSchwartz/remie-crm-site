// netlify/functions/cron-clear-appointment-tags.js
// Runs every 5 minutes to clear past-due appointment tags from message_contacts.

const { getServiceClient } = require("./_supabase");
const supabase = getServiceClient();

exports.config = { schedule: "*/5 * * * *" }; // every 5 minutes

function isObject(v) { return v && typeof v === "object" && !Array.isArray(v); }

exports.handler = async () => {
  try {
    const nowIso = new Date().toISOString();
    const page = 1000;
    let from = 0;

    for (;;) {
      // Fetch contacts that still have the tag and whose appointment time is due
      const { data, error } = await supabase
        .from("message_contacts")
        .select("id,tags,meta")
        .contains("tags", ["appointment"])
        .filter("meta->>appointment_at", "lte", nowIso)
        .range(from, from + page - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      // Prepare updates
      const updates = data.map((row) => {
        const curTags = Array.isArray(row.tags) ? row.tags : [];
        const nextTags = curTags.filter((t) => String(t).toLowerCase() !== "appointment");
        const meta = isObject(row.meta) ? { ...row.meta } : {};

        // Clean up appointment-related keys
        delete meta.appointment_at;
        delete meta.follow_up_at;
        delete meta.next_follow_up_at;
        delete meta.calendar_type;
        delete meta.appointment;

        return { id: row.id, tags: nextTags, meta };
      });

      // Apply in one batch (onConflict: id makes this a fast targeted update)
      const { error: updErr } = await supabase
        .from("message_contacts")
        .upsert(updates, { onConflict: "id" });
      if (updErr) throw updErr;

      if (data.length < page) break;
      from += page;
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error("cron-clear-appointment-tags:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message || String(e) }) };
  }
};
