// netlify/functions/telnyx-status.js
// Telnyx SMS status webhook -> update messages.status via provider_sid.
// Sets status: delivered | undelivered | failed | queued | sending | sent (best-effort)
// Stores error_detail if present.

const { getServiceClient } = require("./_supabase");

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// Try to normalize various Telnyx event shapes.
function extractStatusPayload(evt) {
  // Telnyx sends { data: { event_type, id, occurred_at, payload } }
  const data = evt && (evt.data || evt);
  const eventType = data?.event_type || data?.type || evt?.type || "";
  const payload = data?.payload || data?.record || data;

  // Common fields across event types
  const provider_sid =
    payload?.id ||
    payload?.message_id ||
    payload?.original_message_id ||
    data?.id ||
    payload?.payload?.message_id;

  // Delivery status buckets
  let normalizedStatus = null;
  let error_detail = null;

  // Newer events
  if (eventType === "message.delivery_status") {
    const s = payload?.delivery_status?.toLowerCase();
    if (["delivered", "undelivered", "failed", "sent", "queued", "sending"].includes(s)) {
      normalizedStatus = s;
    }
    error_detail =
      payload?.errors?.map?.(e => e?.detail)?.filter(Boolean)?.join("; ") ||
      payload?.delivery_status_error ||
      null;
  }

  // Older finalization event
  if (!normalizedStatus && eventType === "message.finalized") {
    const s = payload?.finalized_status?.toLowerCase() || payload?.delivery_status?.toLowerCase();
    if (["delivered", "undelivered", "failed", "sent", "queued", "sending"].includes(s)) {
      normalizedStatus = s;
    }
    error_detail =
      payload?.errors?.map?.(e => e?.detail)?.filter(Boolean)?.join("; ") ||
      payload?.error ||
      null;
  }

  // Fallback heuristics
  if (!normalizedStatus) {
    const s =
      payload?.delivery_status ||
      payload?.status ||
      payload?.finalized_status ||
      "";
    const sLower = String(s).toLowerCase();
    if (["delivered", "undelivered", "failed", "sent", "queued", "sending"].includes(sLower)) {
      normalizedStatus = sLower;
    }
  }

  // Default unknown statuses to 'undelivered' only if explicit error present; otherwise leave null
  if (!normalizedStatus && error_detail) {
    normalizedStatus = "undelivered";
  }

  return {
    eventType,
    provider_sid,
    normalizedStatus,
    error_detail,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { provider_sid, normalizedStatus, error_detail, eventType } = extractStatusPayload(body);

  if (!provider_sid) {
    // Nothing to do; acknowledge to avoid Telnyx retries but log nothing.
    return json({ ok: true, ignored: true, reason: "No provider_sid found" });
  }

  // Map status to the schema you specified (delivered|undelivered). Keep others if you track them.
  let statusToStore = normalizedStatus;
  if (!statusToStore) {
    // If Telnyx didn't give a clear status, don't overwrite an existing status.
    return json({ ok: true, ignored: true, reason: "No clear status" });
  }

  // Collapse 'failed' into 'undelivered' for your two-state schema, keep others if you store them.
  if (statusToStore === "failed") statusToStore = "undelivered";

  const supabase = getServiceClient();

  // Update by provider_sid
  const update = {
    status: statusToStore,
    updated_at: new Date().toISOString(),
  };
  if (error_detail) update.error_detail = error_detail;

  const { error } = await supabase
    .from("messages")
    .update(update)
    .eq("provider_sid", provider_sid);

  if (error) {
    return json({ ok: false, error: error.message, provider_sid, eventType }, 500);
  }

  return json({ ok: true, provider_sid, status: statusToStore, eventType });
};
