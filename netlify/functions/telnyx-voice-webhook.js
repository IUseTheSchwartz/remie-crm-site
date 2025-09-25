// netlify/functions/telnyx-voice-webhook.js
// Logs to *your* call_logs schema and transfers agent -> lead after answer.
//
// Writes fields:
// - user_id, contact_id
// - direction ('outbound'), to_number (lead), from_number (your DID), agent_number (your cell)
// - telnyx_leg_a_id (agent leg call_control_id), telnyx_leg_b_id (best-effort; see note)
// - status ('ringing' -> 'answered'/'bridged' -> 'completed' or 'failed')
// - started_at / answered_at / ended_at / duration_seconds
//
// Requires env: TELNYX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE(_KEY)
// Optional: TELNYX_WEBHOOK_SECRET (HMAC style; if unset we skip signature check)

const crypto = require("crypto");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || ""; // HMAC (v1-style)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

const supa = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

function log(...args) { try { console.log("[telnyx-webhook]", ...args); } catch {} }

// --- Signature verification (allow-all if secret not set)
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;
  try {
    const parts = String(signatureHeader).split(",").map(s => s.trim());
    const ts = parts.find(p => p.startsWith("t="))?.split("=")[1];
    const sig = parts.find(p => p.startsWith("sig="))?.split("=")[1];
    if (!ts || !sig) return false;
    const payload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac("sha256", TELNYX_WEBHOOK_SECRET);
    hmac.update(payload);
    const digest = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

// --- client_state comes from your /call-start (base64 JSON)
function decodeClientState(any) {
  try {
    if (!any) return null;
    if (typeof any === "object") return any;
    const s = String(any);
    // base64?
    if (/^[A-Za-z0-9+/=]+={0,2}$/.test(s)) {
      const json = Buffer.from(s, "base64").toString("utf8");
      return JSON.parse(json);
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Call transfer: agent leg -> lead leg
async function transferCall({ callControlId, to, from }) {
  if (!TELNYX_API_KEY) { log("transfer skipped: no TELNYX_API_KEY"); return; }
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, from }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) log("transfer failed", resp.status, data);
  else log("transfer ok", { to, from });
}

// --------------- DB helpers ---------------

async function upsertInitiated(row) {
  if (!supa) return;
  const started = row.started_at || new Date().toISOString();
  const payload = {
    user_id: row.user_id,
    contact_id: row.contact_id || null,
    direction: "outbound",
    to_number: row.to_number,
    from_number: row.from_number,
    agent_number: row.agent_number || null,
    telnyx_leg_a_id: row.telnyx_leg_a_id, // agent leg id
    status: "ringing",
    started_at: started,
  };
  // On conflict by leg_a id: update minimal fields that might have been missing
  const { error } = await supa
    .from("call_logs")
    .upsert(payload, { onConflict: "telnyx_leg_a_id" });
  if (error) log("upsert initiated err", error.message);
}

async function setAnswered({ legAId, occurred_at }) {
  if (!supa || !legAId) return;
  const answered = occurred_at || new Date().toISOString();
  const { error } = await supa
    .from("call_logs")
    .update({ status: "answered", answered_at: answered })
    .eq("telnyx_leg_a_id", legAId);
  if (error) log("update answered err", error.message);
}

async function setBridged({ legAId, maybeLegBId }) {
  if (!supa || !legAId) return;
  const updates = { status: "bridged" };
  if (maybeLegBId) updates.telnyx_leg_b_id = maybeLegBId;
  const { error } = await supa
    .from("call_logs")
    .update(updates)
    .eq("telnyx_leg_a_id", legAId);
  if (error) log("update bridged err", error.message);
}

async function setEnded({ legAId, occurred_at, failed = false }) {
  if (!supa || !legAId) return;
  const ended = occurred_at || new Date().toISOString();

  // compute duration = ended - started_at (if present)
  let duration_seconds = null;
  try {
    const { data: row } = await supa
      .from("call_logs")
      .select("started_at")
      .eq("telnyx_leg_a_id", legAId)
      .maybeSingle();
    if (row?.started_at) {
      const t0 = new Date(row.started_at).getTime();
      const t1 = new Date(ended).getTime();
      duration_seconds = Math.max(0, Math.round((t1 - t0) / 1000));
    }
  } catch {}

  const updates = {
    status: failed ? "failed" : "completed",
    ended_at: ended,
  };
  if (duration_seconds !== null) updates.duration_seconds = duration_seconds;

  const { error } = await supa
    .from("call_logs")
    .update(updates)
    .eq("telnyx_leg_a_id", legAId);
  if (error) log("update ended err", error.message);
}

// Best-effort: if we ever see an event that hints the “other leg id”,
// stash it into telnyx_leg_b_id.
async function maybeSetLegB({ legAId, legBId }) {
  if (!supa || !legAId || !legBId) return;
  const { error } = await supa
    .from("call_logs")
    .update({ telnyx_leg_b_id: legBId })
    .eq("telnyx_leg_a_id", legAId);
  if (error) log("update legB err", error.message);
}

// --------------- Handler ---------------
exports.handler = async (event) => {
  const rawBody = event.body || "";
  const sig =
    event.headers["telnyx-signature"] ||
    event.headers["telnyx-signature-ed25519"] ||
    event.headers["Telnyx-Signature"] ||
    event.headers["Telnyx-Signature-Ed25519"];

  if (!verifySignature(rawBody, sig)) {
    log("invalid signature");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { log("json parse error"); return { statusCode: 200, body: "ok" }; }

  const data = payload?.data || {};
  const eventType = data?.event_type || data?.record_type;
  const p = data?.payload || data; // v2 payloads often nest under data.payload
  const occurred_at = p?.occurred_at || payload?.occurred_at || new Date().toISOString();

  // Leg identifiers
  const call_control_id =
    p?.call_control_id ||
    p?.call_control_ids?.[0] || null; // some events use arrays

  // Some webhooks include session grouping; useful if you later want to track both legs
  const call_session_id = p?.call_session_id || null; // (FYI only; not stored by your current schema) :contentReference[oaicite:1]{index=1}

  // client_state we set from /call-start (base64 JSON)
  const clientState =
    decodeClientState(p?.client_state) ||
    decodeClientState(p?.client_state_b64);

  const kind = clientState?.kind || null; // "crm_outbound"
  const user_id = clientState?.user_id || clientState?.agent_id || null;
  const contact_id = clientState?.contact_id || null;
  const lead_number = clientState?.lead_number || p?.to || null;
  const from_number = clientState?.from_number || p?.from || null;
  const agent_number = clientState?.agent_number || null;

  log("event", eventType, {
    hasId: !!call_control_id,
    kind,
    cs: !!clientState,
    sess: call_session_id ? call_session_id.slice(0,8) + "…" : null
  });

  try {
    switch (eventType) {
      case "call.initiated": {
        // First leg (agent) gets initiated when you POST /v2/calls. :contentReference[oaicite:2]{index=2}
        if (call_control_id && user_id && lead_number && from_number) {
          await upsertInitiated({
            user_id,
            contact_id,
            to_number: lead_number,
            from_number,
            agent_number,
            telnyx_leg_a_id: call_control_id,
            started_at: occurred_at,
          });
        }
        break;
      }

      case "call.answered": {
        // Transfer the answered AGENT leg to the LEAD. :contentReference[oaicite:3]{index=3}
        if (kind === "crm_outbound" && call_control_id && lead_number && from_number) {
          await transferCall({ callControlId: call_control_id, to: lead_number, from: from_number });
        }
        if (call_control_id) {
          await setAnswered({ legAId: call_control_id, occurred_at });
        }
        break;
      }

      case "call.bridged": {
        // Once bridged, we consider the call in-progress between agent & lead. :contentReference[oaicite:4]{index=4}
        // Some payloads include a peer/other leg id; if present, store it.
        const peer =
          p?.other_leg_id ||
          p?.peer_call_control_id ||
          p?.bridge_target_call_control_id ||
          null;
        await setBridged({ legAId: call_control_id, maybeLegBId: peer });
        if (peer) await maybeSetLegB({ legAId: call_control_id, legBId: peer });
        break;
      }

      case "call.ended":
      case "call.hangup": {
        // End of the (agent) leg; compute duration from started_at.
        const failed = p?.hangup_cause && p.hangup_cause !== "normal_clearing";
        await setEnded({ legAId: call_control_id, occurred_at, failed });
        break;
      }

      // Optional: if we ever see a second leg “initiated” with same session,
      // capture it as telnyx_leg_b_id best-effort.
      case "call.transfer.initiated":
      case "call.transfer.completed":
      case "call.initiated.outbound":
      case "call.answered.outbound": {
        const maybeB = p?.call_control_id || null;
        if (maybeB && call_session_id) {
          // naive: if this event isn't on leg A but shares session and we have state,
          // treat as leg B. (Your schema doesn't store session_id; we keep best-effort only.)
          await maybeSetLegB({ legAId: call_control_id, legBId: maybeB });
        }
        break;
      }

      default:
        // ignore chatty events
        break;
    }
  } catch (e) {
    log("handler error", e?.message);
  }

  return { statusCode: 200, body: "ok" };
};
