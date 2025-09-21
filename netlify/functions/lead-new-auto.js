// File: netlify/functions/lead-new-auto.js
// Ensures a contact exists (so it shows in Contacts) before sending the initial template.
// Uses calendar-friendly tag selection (military if branch present, else lead).

const { getServiceClient } = require("./_supabase");

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

const S = (x) => (x == null ? "" : String(x).trim());
const norm10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const toE164 = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p).startsWith("+")) return String(p);
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

    // ---- Upsert contact (bullet-proof) ----
    // Status tag is exclusive: 'military' if branch present, else 'lead'
    const statusTag = S(lead.military_branch) ? "military" : "lead";

    try {
      const insertPayload = {
        user_id: lead.user_id,
        phone: e164,                 // store E164
        full_name: lead.name || null,
        subscribed: true,            // ✅ satisfy NOT NULL schemas
        archived: false,             // ✅ include if your schema has NOT NULL archived
        tags: [statusTag],           // keep status exclusive; other tags can be merged later
        meta: { lead_id: lead.id },  // handy cross-link
      };

      // Upsert by (user_id, phone). Adjust onConflict if your unique index is different.
      const { error: upErr } = await db
        .from("message_contacts")
        .upsert(insertPayload, { onConflict: "user_id,phone" });
      if (upErr) throw upErr;

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
        templateKey,
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
