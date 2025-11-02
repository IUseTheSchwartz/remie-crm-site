// netlify/functions/telnyx-status.js
// Telnyx SMS status webhook -> update messages.status via provider_sid.
// Stores error_detail if present. No side-effects beyond messages table.

const { getServiceClient } = require("./_supabase");

function ok(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

function extract(evt) {
  const data = evt?.data || evt;
  const eventType = data?.event_type || data?.type || "";
  const payload = data?.payload || data?.record || data;

  const provider_sid =
    payload?.id ||
    payload?.message_id ||
    data?.id ||
    payload?.payload?.message_id ||
    null;

  // Try to normalize status across variants
  const rawStatus =
    (payload?.delivery_status || payload?.finalized_status || payload?.status || "")
      .toString()
      .toLowerCase();

  let status = null;
  if (["delivered","undelivered","failed","sent","queued","sending"].includes(rawStatus)) {
    status = rawStatus;
  }

  // Collapse "failed" -> "undelivered" per two-state schema
  if (status === "failed") status = "undelivered";

  const error_detail =
    (payload?.errors && payload.errors.map(e => e?.detail).filter(Boolean).join("; ")) ||
    payload?.delivery_status_error ||
    payload?.error ||
    null;

  return { provider_sid, status, error_detail, eventType };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return ok({ ok: false, error: "Method not allowed" }, 405);

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return ok({ ok: false, error: "Invalid JSON" }, 400); }

  const { provider_sid, status, error_detail, eventType } = extract(body);
  if (!provider_sid) return ok({ ok: true, ignored: true, reason: "no_provider_sid" });

  if (!status && !error_detail) {
    // Nothing actionable—ack so Telnyx doesn't retry.
    return ok({ ok: true, ignored: true, reason: "no_status" });
  }

  const db = getServiceClient();
  const update = { updated_at: new Date().toISOString() };
  if (status) update.status = status;
  if (error_detail) update.error_detail = error_detail;

  const { error } = await db.from("messages").update(update).eq("provider_sid", provider_sid);
  if (error) return ok({ ok: false, error: error.message, provider_sid, eventType }, 500);

  return ok({ ok: true, provider_sid, status: update.status || null, eventType });
};
