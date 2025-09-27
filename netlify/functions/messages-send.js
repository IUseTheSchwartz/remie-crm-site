// Sends an SMS via Telnyx using a template or raw body.
// DEDUPE-SAFE using provider_message_id (pass it!)
// Accepts: { to?, contact_id?, lead_id?, body?, templateKey?/template_key?/template?, requesterId?, provider_message_id?, sent_by_ai? }

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch"); // ensure fetch exists in function runtime

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const S = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const norm10 = (p) => onlyDigits(p).slice(-10);

function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

// tiny mustache: {{ token }}
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return String(tpl)
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = ctx && Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : "";
      return v == null ? "" : String(v);
    })
    .trim();
}

async function getLead(db, lead_id) {
  const { data, error } = await db
    .from("leads")
    .select("id, user_id, name, phone, email, state, beneficiary, beneficiary_name, military_branch")
    .eq("id", lead_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getContact(db, user_id, contact_id) {
  const { data, error } = await db
    .from("message_contacts")
    .select("id, user_id, phone, full_name, tags, subscribed, created_at")
    .eq("user_id", user_id)
    .eq("id", contact_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findContactByPhone(db, user_id, phoneLike) {
  const d10 = norm10(phoneLike);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, user_id, phone, full_name, tags, subscribed, created_at")
    .eq("user_id", user_id);
  if (error) throw error;
  return (data || []).find((c) => norm10(c.phone) === d10) || null;
}

// schema-agnostic to avoid column mismatches
async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getTemplatesRow(db, user_id) {
  const { data, error } = await db
    .from("message_templates")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// WALLET helper
async function getBalanceCents(db, user_id) {
  const { data, error } = await db
    .from("user_wallets")
    .select("balance_cents")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.balance_cents ?? 0);
}

/* ====== NEW: TFN status via toll_free_numbers ======
   Returns { status: 'verified'|'pending'|'none', e164?: string }
==================================================== */
async function getAgentTFNStatus(db, user_id) {
  const { data, error } = await db
    .from("toll_free_numbers")
    .select("phone_number, verified")
    .eq("assigned_to", user_id)
    .order("verified", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!data) return { status: "none" };
  const e = toE164(data.phone_number);
  if (!e) return { status: "none" };
  return data.verified ? { status: "verified", e164: e } : { status: "pending", e164: e };
}

// ---- Telnyx send ----
async function telnyxSend({ from, to, text, profileId }) {
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY missing");
  const payload = {
    to,
    text,
    ...(profileId ? { messaging_profile_id: profileId } : {}),
    ...(from ? { from } : {}),
  };
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = out?.errors?.[0]?.detail || JSON.stringify(out);
    const err = new Error(`Telnyx send failed: ${detail}`);
    err.telnyx_response = out;
    throw err;
  }
  return out; // contains data.id, etc.
}

function chooseFallbackKey(reqKey, { isMilitary }) {
  const wanted = S(reqKey).trim();
  if (wanted) return wanted;
  return isMilitary ? "new_lead_military" : "new_lead";
}

exports.handler = async (event) => {
  const trace = [];
  const db = getServiceClient();

  try {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    let {
      to,
      contact_id,
      lead_id,
      body: rawBody,
      templateKey, // camelCase
      requesterId,
      provider_message_id,
      sent_by_ai, // <-- NEW: allow AI to tag the message
    } = body || {};

    // accept snake_case too
    templateKey = body.template_key || body.template || templateKey;

    // -------- Resolve user_id, contact, destination phone --------
    let user_id = null;
    let contact = null;
    let lead = null;

    if (lead_id) {
      lead = await getLead(db, lead_id);
      if (!lead) return json({ error: "lead_not_found", lead_id, trace }, 404);
      user_id = lead.user_id;
      to = to || lead.phone;
      trace.push({ step: "lead.loaded", lead_id, user_id });
    }

    if (!user_id && requesterId) user_id = requesterId;

    if (contact_id) {
      if (!user_id) {
        const { data: cRow, error } = await db
          .from("message_contacts")
          .select("user_id")
          .eq("id", contact_id)
          .maybeSingle();
        if (error) throw error;
        user_id = cRow?.user_id || user_id;
      }
      contact = await getContact(db, user_id, contact_id);
      if (!contact) return json({ error: "contact_not_found", contact_id, trace }, 404);
      to = to || contact.phone;
      trace.push({ step: "contact.loaded", contact_id, user_id });
    }

    if (!user_id) {
      return json({ error: "missing_user_context", hint: "provide lead_id, contact_id, or requesterId", trace }, 400);
    }

    const toE = toE164(to);
    if (!toE) return json({ error: "invalid_destination", to, trace }, 400);

    if (!contact) {
      contact = await findContactByPhone(db, user_id, toE);
      if (contact) trace.push({ step: "contact.resolved_by_phone", contact_id: contact.id });
    }

    // -------- DEDUPE: provider_message_id guard --------
    if (provider_message_id) {
      const { data: dupe, error: dErr } = await db
        .from("messages")
        .select("id, provider_sid, created_at")
        .eq("user_id", user_id)
        .eq("provider_message_id", provider_message_id)
        .limit(1);
      if (dErr) throw dErr;
      if (dupe && dupe.length) {
        trace.push({ step: "dedupe.hit", provider_message_id });
        return json({ ok: true, deduped: true, provider_message_id, trace });
      }
    }

    // -------- Build message body (template or raw) --------
    let bodyText = String(rawBody || "").trim();

    if (!bodyText) {
      const mt = await getTemplatesRow(db, user_id);
      if (!mt) return json({ error: "template_not_configured", trace }, 400);

      const enabledGlobal = typeof mt.enabled === "boolean" ? mt.enabled : true;
      const enabledByKey =
        mt.enabled && typeof mt.enabled === "object" ? mt.enabled[templateKey] : undefined;
      const isEnabled = enabledGlobal && enabledByKey !== false;
      if (!isEnabled) return json({ status: "skipped_disabled", templateKey, trace });

      const tags = Array.isArray(contact?.tags) ? contact.tags.map(String) : [];
      const isMilitary = S(lead?.military_branch) || tags.includes("military");

      const keyToUse = chooseFallbackKey(templateKey, { isMilitary: !!isMilitary });
      const T = (k) => mt.templates?.[k] ?? mt[k] ?? "";
      let tpl = String(T(keyToUse) || "").trim();

      if (!tpl && keyToUse === "new_lead_military") tpl = String(T("new_lead") || "").trim();
      if (!tpl && keyToUse === "new_lead") tpl = String(T("new_lead_military") || "").trim();

      if (!tpl)
        return json(
          { error: "template_not_found", requested: templateKey, tried: keyToUse, trace },
          404
        );

      const ap = await getAgentProfile(db, user_id);
      const ctx = {
        first_name: "",
        last_name: "",
        full_name: "",
        state: "",
        beneficiary: "",
        military_branch: "",
        agent_name: ap?.name || ap?.full_name || "",
        company: ap?.company || "",
        agent_phone: ap?.phone || "",
        agent_email: ap?.email || "",
        calendly_link: ap?.calendly_link || ap?.calendly_url || "",
      };

      const fullName = lead?.name || contact?.full_name || "";
      if (fullName) {
        ctx.full_name = fullName;
        const parts = fullName.split(/\s+/).filter(Boolean);
        ctx.first_name = parts[0] || "";
        ctx.last_name = parts.slice(1).join(" ");
      }
      ctx.state = lead?.state || "";
      ctx.beneficiary = lead?.beneficiary || lead?.beneficiary_name || "";
      ctx.military_branch = S(lead?.military_branch) || (tags.includes("military") ? "Military" : "");

      bodyText = renderTemplate(tpl, ctx);
      if (!bodyText) return json({ error: "rendered_empty_body", trace }, 400);

      trace.push({ step: "template.rendered", key: keyToUse, body_len: bodyText.length });
    }

    // -------- Determine FROM number & verification status --------
    const tfn = await getAgentTFNStatus(db, user_id);
    if (tfn.status === "pending") {
      return json(
        {
          error: "tfn_pending_verification",
          message:
            "Your toll-free number is pending verification (typically 4–7 business days). Outbound texting will enable automatically once approved.",
          trace,
        },
        409
      );
    }
    if (tfn.status !== "verified") {
      return json(
        {
          error: "no_agent_tfn_configured",
          hint: "Assign a verified toll-free number in Messaging Settings.",
          trace,
        },
        400
      );
    }
    const fromE164 = tfn.e164;

    // -------- WALLET pre-flight --------
    const COST_CENTS = 1; // keep in sync with webhook/trigger
    let balance = 0;
    try {
      balance = await getBalanceCents(db, user_id);
    } catch {
      balance = 0;
    }
    if (balance < COST_CENTS) {
      return json({ error: "insufficient_balance", balance_cents: balance, trace }, 402);
    }

    // -------- Send via Telnyx --------
    if (!TELNYX_API_KEY) return json({ error: "missing_telnyx_api_key", trace }, 500);

    let telnyxResp;
    try {
      telnyxResp = await telnyxSend({
        from: fromE164,
        to: toE,
        text: bodyText,
        profileId: MESSAGING_PROFILE_ID,
      });
      trace.push({ step: "telnyx.sent", id: telnyxResp?.data?.id, used_from: fromE164 });
    } catch (e) {
      trace.push({ step: "telnyx.error", detail: e?.message || String(e) });
      return json(
        {
          error: "send_failed",
          detail: e?.message || String(e),
          telnyx_response: e?.telnyx_response,
          trace,
        },
        502
      );
    }

    const provider_sid = telnyxResp?.data?.id || null;

    // -------- Insert message row --------
    const row = {
      user_id,
      contact_id: contact?.id || null,
      direction: "outgoing",
      provider: "telnyx",
      from_number: fromE164,
      to_number: toE,
      body: bodyText,
      status: "sent",
      provider_sid,
      provider_message_id: provider_message_id || null,
      price_cents: COST_CENTS,
      meta: { templateKey: templateKey || null, lead_id: lead?.id || (lead_id || null) },
      sent_by_ai: Boolean(sent_by_ai) === true, // tiny flag for UI badge
    };

    const ins = await db.from("messages").insert([row]).select("id, contact_id").maybeSingle();
    if (ins?.error) {
      const msg = ins.error?.message || ins.error?.hint || "unknown_db_error";
      if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
        trace.push({ step: "insert.duplicate", provider_message_id });
        return json({ ok: true, deduped: true, provider_message_id, trace });
      }
      console.error("[messages-send] db insert failed:", ins.error);
      return json({ error: `db_insert_failed: ${msg}`, trace }, 500);
    }

    return json({
      ok: true,
      id: ins?.data?.id || null,
      provider_sid,
      provider_message_id: provider_message_id || null,
      contact_id: ins?.data?.contact_id || contact?.id || null,
      trace,
    });
  } catch (e) {
    console.error("[messages-send] unhandled:", e);
    return json({ error: "unhandled", detail: String(e?.message || e) });
  }
};
