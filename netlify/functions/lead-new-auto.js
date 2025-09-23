// File: netlify/functions/lead-new-auto.js
// Ensures a contact row exists (so it shows in Contacts) before sending the initial template.
// Matches existing contact by same user + same digits of phone (schema-safe; no onConflict required).

const { getServiceClient } = require("./_supabase");

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

const S = (x) => (x == null ? "" : String(x).trim());
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const norm10 = (p) => onlyDigits(p).slice(-10);
const toE164 = (p) => {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
};

exports.handler = async (event) => {
  const trace = [];
  try {
    const db = getServiceClient();

    // ---- Parse body ----
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json({ error: "invalid_json", trace }, 400);
    }
    const { lead_id } = body || {};
    if (!lead_id) return json({ error: "missing_lead_id", trace }, 400);

    // ---- Load lead ----
    const { data: lead, error: lerr } = await db
      .from("leads")
      .select(
        "id,user_id,name,phone,state,beneficiary,beneficiary_name,military_branch"
      )
      .eq("id", lead_id)
      .maybeSingle();

    if (lerr) return json({ error: "lead_lookup_failed", detail: lerr.message, trace }, 500);
    if (!lead) return json({ error: "lead_not_found", lead_id, trace }, 404);
    trace.push({ step: "lead.loaded", lead_id: lead.id, user_id: lead.user_id });

    const e164 = toE164(lead.phone || "");
    if (!e164) return json({ error: "invalid_or_missing_lead_phone", trace }, 400);

    // ---- Upsert contact (schema-safe; no onConflict) ----
    // Status tag is exclusive: 'military' if branch present, else 'lead'
    const statusTag = S(lead.military_branch) ? "military" : "lead";

    try {
      const phoneDigits = onlyDigits(e164);

      // Load user's contacts and match by digits (uses your idx_message_contacts_phone_digits pattern)
      const { data: existingRows, error: selErr } = await db
        .from("message_contacts")
        .select("id, phone, tags")
        .eq("user_id", lead.user_id)
        .order("created_at", { ascending: false });
      if (selErr) throw selErr;

      const existing =
        (existingRows || []).find((r) => onlyDigits(r.phone) === phoneDigits) || null;

      const base = {
        user_id: lead.user_id,
        phone: e164,                 // store E.164
        full_name: lead.name || null,
        subscribed: true,            // satisfy NOT NULL
        meta: { lead_id: lead.id },  // cross-link
      };

      if (existing?.id) {
        // keep status tag exclusive
        const cur = Array.isArray(existing.tags) ? existing.tags : [];
        const withoutStatus = cur.filter(
          (t) => !["lead", "military"].includes(String(t).toLowerCase())
        );
        const nextTags = [...new Set([...withoutStatus, statusTag])];

        const { error: uErr } = await db
          .from("message_contacts")
          .update({ ...base, tags: nextTags })
          .eq("id", existing.id);
        if (uErr) throw uErr;
      } else {
        const { error: iErr } = await db
          .from("message_contacts")
          .insert([{ ...base, tags: [statusTag] }]);
        if (iErr) throw iErr;
      }

      trace.push({ step: "contact.upsert.ok", phone: e164, tag: statusTag });
    } catch (e) {
      trace.push({ warn: "contact.upsert.failed", detail: String(e?.message || e) });
    }

    // ---- Template selection (lead vs military) ----
    const templateKey = S(lead.military_branch) ? "new_lead_military" : "new_lead";
    const provider_message_id = `auto_${templateKey}_${lead.id}`;

    // ---- Build base URL and call messages-send ----
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host =
      event.headers.host ||
      (process.env.URL || process.env.SITE_URL || "").replace(/^https?:\/\//, "");
    const base = process.env.SITE_URL || (proto && host ? `${proto}://${host}` : null);
    if (!base) return json({ error: "no_base_url", trace }, 500);

    const res = await fetch(`${base}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id,
        template_key: templateKey,     // ← ← FIXED: use snake_case key
        provider_message_id,
      }),
    });

    const text = await res.text();
    let inner = null;
    try {
      inner = JSON.parse(text);
    } catch {}
    trace.push({ step: "messages-send.invoked", status: res.status });

    return json(
      {
        ok: !!inner?.ok,
        lead_id,
        send_status: res.status,
        send: inner,
        trace,
      },
      res.ok ? 200 : 207
    );
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e), trace }, 500);
  }
};