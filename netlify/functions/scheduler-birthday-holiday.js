// File: netlify/functions/scheduler-birthday-holiday.js (CommonJS, scheduled)
const { getServiceClient } = require("./_supabase.js");
const {
  renderTemplate, sendSmsTelnyx, logEvent, getAgentContext, toE164
} = require("./lib/messaging.js");
const supabase = getServiceClient();

module.exports.config = { schedule: "0 15 * * *" }; // daily 15:00 UTC

module.exports.handler = async () => {
  try {
    const today = new Date();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");

    // pull all users with messaging rows
    const { data: mtRows, error: mtErr } = await supabase
      .from("message_templates")
      .select("user_id, templates, enabled");
    if (mtErr) throw mtErr;

    const startOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
    const endOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString();

    const isTodayHoliday = () => {
      const fixed = new Set([`01-01`, `07-04`, `12-25`]); // extend as needed
      const md = `${mm}-${dd}`;
      if (fixed.has(md)) return true;
      // Thanksgiving (USA) 4th Thu of Nov
      if (mm !== "11") return false;
      const d = new Date(Date.UTC(today.getUTCFullYear(), 10, 1));
      let thu = 0, target = null;
      for (let i = 0; i < 30; i++) {
        if (d.getUTCDay() === 4) { thu++; if (thu === 4) { target = d; break; } }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      if (!target) return false;
      const m = String(target.getUTCMonth() + 1).padStart(2, "0");
      const day = String(target.getUTCDate()).padStart(2, "0");
      return `${m}-${day}` === `${mm}-${dd}`;
    };

    for (const mt of mtRows || []) {
      const userId = mt.user_id;
      const enabled = (mt.enabled ?? {}) || {};
      const templates = (mt.templates ?? {}) || {};

      const agent = await getAgentContext(userId);

      // Birthdays
      if (enabled.birthday_text) {
        const { data: bday } = await supabase
          .from("message_contacts")
          .select("id, full_name, phone, meta, subscribed")
          .eq("user_id", userId)
          .eq("subscribed", true)
          .contains("meta", { birthday_opt_in: true });

        for (const c of bday || []) {
          const dob = c?.meta?.dob; // YYYY-MM-DD
          if (!dob || typeof dob !== "string" || dob.length < 10) continue;
          if (dob.slice(5, 10) !== `${mm}-${dd}`) continue;

          // prevent duplicates today
          const { count } = await supabase
            .from("message_events")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("contact_id", c.id)
            .eq("template_key", "birthday_text")
            .gte("sent_at", startOfDay)
            .lt("sent_at", endOfDay);
          if (count > 0) continue;

          const first_name = (c.full_name || "").trim().split(/\s+/)[0] || "";
          const ctx = { ...agent, first_name, full_name: c.full_name || "" };
          const tpl = templates.birthday_text || "";
          const text = renderTemplate(tpl, ctx).trim() || renderTemplate(
            "Hi {{first_name}}, this is {{agent_name}}. Happy Birthday! 🎉 Wishing you a great year. Text me at {{agent_phone}}.",
            ctx
          );
          const to = toE164(c.phone);
          if (!to) continue;

          await sendSmsTelnyx({ to, text });
          await logEvent({ userId, contactId: c.id, leadId: null, templateKey: "birthday_text", to, body: text, meta: { date: `${today.getUTCFullYear()}-${mm}-${dd}` } });
        }
      }

      // Holidays
      if (enabled.holiday_text && isTodayHoliday()) {
        const { data: hol } = await supabase
          .from("message_contacts")
          .select("id, full_name, phone, meta, subscribed")
          .eq("user_id", userId)
          .eq("subscribed", true)
          .contains("meta", { holiday_opt_in: true });

        for (const c of hol || []) {
          const { count } = await supabase
            .from("message_events")
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("contact_id", c.id)
            .eq("template_key", "holiday_text")
            .gte("sent_at", startOfDay)
            .lt("sent_at", endOfDay);
          if (count > 0) continue;

          const first_name = (c.full_name || "").trim().split(/\s+/)[0] || "";
          const ctx = { ...agent, first_name, full_name: c.full_name || "" };
          const tpl = templates.holiday_text || "";
          const text = renderTemplate(tpl, ctx).trim() || renderTemplate(
            "Hi {{first_name}}, this is {{agent_name}}. Wishing you and your family a happy holiday! Text me at {{agent_phone}} if you need anything.",
            ctx
          );
          const to = toE164(c.phone);
          if (!to) continue;

          await sendSmsTelnyx({ to, text });
          await logEvent({ userId, contactId: c.id, leadId: null, templateKey: "holiday_text", to, body: text, meta: { date: `${today.getUTCFullYear()}-${mm}-${dd}` } });
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || "Scheduler error" };
  }
};
