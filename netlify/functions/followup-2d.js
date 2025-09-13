const { createClient } = require("@supabase/supabase-js");

// Helpers
const S = (x) => (x == null ? "" : String(x).trim());
const render = (tpl, ctx) => String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
const normalizePhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; // 10 digits for US
};

exports.handler = async () => {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE,
    SITE_URL,
    URL,
    FOLLOWUP_TEST_MINUTES, // optional: for quick testing
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return resp(500, { error: "Supabase env not set" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Time window: default 2 days, but override with FOLLOWUP_TEST_MINUTES for testing
  const windowMs = FOLLOWUP_TEST_MINUTES
    ? Number(FOLLOWUP_TEST_MINUTES) * 60 * 1000
    : 2 * 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(Date.now() - windowMs).toISOString();

  // 1) Candidates: leads older than cutoff, with a phone
  const { data: leads, error: LErr } = await supabase
    .from("leads")
    .select("id,user_id,name,phone,state,beneficiary,beneficiary_name,military_branch,created_at")
    .lte("created_at", cutoffISO)
    .not("phone", "is", null);

  if (LErr) return resp(500, { error: "lead_query_failed", detail: LErr.message });
  if (!leads?.length) return resp(200, { ok: true, processed: 0, sent: 0 });

  // Caches
  const tplByUser = new Map();   // user_id -> follow_up_2d template string
  const agentByUser = new Map(); // user_id -> { agent_name, agent_phone, calendly_link }

  let processed = 0;
  let sent = 0;

  for (const lead of leads) {
    processed++;

    const phoneRaw = S(lead.phone);
    if (!phoneRaw) continue;
    const phoneKey = normalizePhone(phoneRaw);
    if (!phoneKey) continue;

    // 2) Find contact and ensure tags include 'lead' OR 'military'
    const { data: contacts, error: CErr } = await supabase
      .from("message_contacts")
      .select("id,phone,tags")
      .eq("user_id", lead.user_id);

    if (CErr) continue;

    const contact = (contacts || []).find(
      (c) => normalizePhone(c.phone) === phoneKey
    );
    if (!contact) continue;

    const tagsNorm = new Set((contact.tags || []).map((t) => S(t).toLowerCase()));
    const isLeadOrMilitary =
      tagsNorm.has("lead") || tagsNorm.has("military");
    if (!isLeadOrMilitary) continue; // 🚫 Skip if neither tag present

    // 3) Must have at least one outgoing since lead creation (don’t follow-up cold)
    const { count: outCount } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", lead.user_id)
      .eq("direction", "outgoing")
      .or(`to_number.eq.${phoneRaw},from_number.eq.${phoneRaw}`)
      .gte("created_at", lead.created_at);
    if (!outCount) continue;

    // 4) Skip if any incoming reply since creation
    const { count: inCount } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", lead.user_id)
      .eq("direction", "incoming")
      .or(`from_number.eq.${phoneRaw},to_number.eq.${phoneRaw}`)
      .gte("created_at", lead.created_at);
    if (inCount && inCount > 0) continue;

    // 5) Skip if follow-up already sent (dedupe using provider_message_id='followup_2d')
    const { count: fuCount } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", lead.user_id)
      .eq("direction", "outgoing")
      .eq("provider_message_id", "followup_2d")
      .or(`to_number.eq.${phoneRaw},from_number.eq.${phoneRaw}`)
      .gte("created_at", lead.created_at);
    if (fuCount && fuCount > 0) continue;

    // 6) Load follow_up_2d template (cached per user)
    if (!tplByUser.has(lead.user_id)) {
      const { data: mt } = await supabase
        .from("message_templates")
        .select("*")
        .eq("user_id", lead.user_id)
        .maybeSingle();

      const followTpl =
        mt?.templates?.follow_up_2d ||
        mt?.follow_up_2d ||
        "";

      tplByUser.set(lead.user_id, followTpl);
    }
    const followTpl = tplByUser.get(lead.user_id);
    if (!S(followTpl)) continue; // no template -> skip

    // 7) Load agent profile (cached per user)
    if (!agentByUser.has(lead.user_id)) {
      const { data: agent } = await supabase
        .from("agent_profiles")
        .select("full_name,phone,calendly_url")
        .eq("user_id", lead.user_id)
        .maybeSingle();

      agentByUser.set(lead.user_id, {
        agent_name: S(agent?.full_name),
        agent_phone: S(agent?.phone),
        calendly_link: S(agent?.calendly_url),
      });
    }
    const agent = agentByUser.get(lead.user_id) || { agent_name: "", agent_phone: "", calendly_link: "" };

    // 8) Render
    const ctx = {
      first_name: S(lead.name).split(/\s+/)[0] || "",
      name: S(lead.name),
      state: S(lead.state),
      beneficiary: S(lead.beneficiary) || S(lead.beneficiary_name),
      ...agent,
    };
    const body = render(followTpl, ctx).trim();
    if (!body) continue;

    // 9) Send via messages-send
    const base = SITE_URL || URL;
    if (!base) return resp(500, { error: "Missing SITE_URL/URL" });

    const res = await fetch(`${base}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phoneRaw,
        body,
        requesterId: lead.user_id,
        lead_id: lead.id,
        client_ref: "followup_2d", // tag row to prevent duplicates
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && !out?.error) sent++;
  }

  return resp(200, { ok: true, processed, sent });
};

function resp(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
