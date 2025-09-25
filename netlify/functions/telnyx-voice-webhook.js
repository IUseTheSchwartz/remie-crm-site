// netlify/functions/telnyx-voice-webhook.js
// Transfers AGENT -> LEAD after answer, and logs to your existing call_logs schema.
//
// Writes/updates (your columns):
// user_id, contact_id, direction, to_number, from_number, agent_number,
// telnyx_leg_a_id, telnyx_leg_b_id, status, started_at, answered_at, ended_at,
// duration_seconds, recording_url, error.

const crypto = require("crypto");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || ""; // optional (HMAC); leave empty to disable
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

const supa = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

function log(...args) { try { console.log("[telnyx-webhook]", ...args); } catch { /* noop */ } }

/* ---------------- Signature (optional, HMAC "t=...,sig=...") ---------------- */
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true;        // disabled
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

/* ---------------- Helpers ---------------- */
function decodeClientState(any) {
  try {
    if (!any) return null;
    if (typeof any === "object") return any;
    const s = String(any);
    // base64 JSON?
    if (/^[A-Za-z0-9+/=]+={0,2}$/.test(s)) {
      const json = Buffer.from(s, "base64").toString("utf8");
      return JSON.parse(json);
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function transferCall({ callControlId, to, from }) {
  if (!TELNYX_API_KEY) { log("transfer skipped: no TELNYX_API_KEY"); return; }
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, from })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) log("transfer failed", resp.status, data);
  else log("transfer ok", { to, from });
}

/* ---------------- DB writes (your schema) ---------------- */
async function upsertInitiated({
  user_id, contact_id, to_number, from_number, agent_number,
  legA, started_at
}) {
  if (!supa) return;

  // If row exists for this legA, update minimal fields; else insert a new one
  const { data: existing } = await supa
    .from("call_logs")
    .select("id")
    .eq("telnyx_leg_a_id", legA)
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supa
      .from("call_logs")
      .update({
        user_id, contact_id,
        to_number, from_number, agent_number,
        status: "ringing",
        started_at: started_at || new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) log("upsert initiated (update) err", error.message);
  } else {
    const { error } = await supa
      .from("call_logs")
      .insert({
        user_id, contact_id,
        direction: "outbound",
        to_number, from_number, agent_number,
        telnyx_leg_a_id: legA,
        status: "ringing",
        started_at: started_at || new Date().toISOString(),
      });
    if (error) log("upsert initiated (insert) err", error.message);
  }
}

async function markAnswered({ legA, answered_at }) {
  if (!supa || !legA) return;
  const { error } = await supa
    .from("call_logs")
    .update({ status: "answered", answered_at: answered_at || new Date().toISOString() })
    .eq("telnyx_leg_a_id", legA);
  if (error) log("markAnswered err", error.message);
}

async function markBridged({ legA, maybeLegB }) {
  if (!supa || !legA) return;
  const updates = { status: "bridged" };
  if (maybeLegB) updates.telnyx_leg_b_id = maybeLegB;
  const { error } = await supa
    .from("call_logs")
    .update(updates)
    .eq("telnyx_leg_a_id", legA);
  if (error) log("markBridged err", error.message);
}

async function markEnded({ legA, ended_at, hangup_cause }) {
  if (!supa || !legA) return;

  // Calculate duration = ended_at - started_at (if started_at exists)
  let duration_seconds = null;
  try {
    const { data: row } = await supa
      .from("call_logs")
      .select("started_at")
      .eq("telnyx_leg_a_id", legA)
      .maybeSingle();
    if (row?.started_at) {
      const t0 = new Date(row.started_at).getTime();
      const t1 = new Date(ended_at || Date.now()).getTime();
      duration_seconds = Math.max(0, Math.round((t1 - t0) / 1000));
    }
  } catch {}

  const failed = hangup_cause && hangup_cause !== "normal_clearing";
  const updates = {
    status: failed ? "failed" : "completed",
    ended_at: ended_at || new Date().toISOString(),
  };
  if (duration_seconds !== null) updates.duration_seconds = duration_seconds;
  if (failed) updates.error = hangup_cause;

  const { error } = await supa
    .from("call_logs")
    .update(updates)
    .eq("telnyx_leg_a_id", legA);
  if (error) log("markEnded err", error.message);
}

/* ---------------- Handler ---------------- */
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

  // Leg IDs
  const legA =
    p?.call_control_id ||
    p?.call_control_ids?.[0] || null;

  // Sometimes Telnyx includes the peer leg in bridged/transfer events
  const peerLeg =
    p?.other_leg_id ||
    p?.peer_call_control_id ||
    p?.bridge_target_call_control_id ||
    null;

  // Client state from /call-start (base64 JSON)
  const cs =
    decodeClientState(p?.client_state) ||
    decodeClientState(p?.client_state_b64) || {};

  const kind = cs.kind || null;                 // "crm_outbound"
  const user_id = cs.user_id || cs.agent_id || null;
  const contact_id = cs.contact_id || null;
  const lead_number = cs.lead_number || p?.to || null;
  const from_number = cs.from_number || p?.from || null; // your DID used as caller ID
  const agent_number = cs.agent_number || null;

  log("event", eventType, {
    hasLegA: !!legA,
    kind,
    leadPrefix: lead_number ? String(lead_number).slice(0,4) + "…" : null
  });

  try {
    switch (eventType) {
      case "call.initiated": {
        // Agent leg created when you POST /v2/calls
        if (legA && user_id && lead_number && from_number) {
          await upsertInitiated({
            user_id, contact_id,
            to_number: lead_number,
            from_number,
            agent_number,
            legA,
            started_at: occurred_at,
          });
        }
        break;
      }

      case "call.answered": {
        // When agent answers, transfer to the lead using our chosen DID
        if (kind === "crm_outbound" && legA && lead_number && from_number) {
          await transferCall({ callControlId: legA, to: lead_number, from: from_number });
        }
        if (legA) await markAnswered({ legA, answered_at: occurred_at });
        break;
      }

      case "call.bridged": {
        await markBridged({ legA, maybeLegB: peerLeg || null });
        break;
      }

      case "call.ended":
      case "call.hangup": {
        await markEnded({ legA, ended_at: occurred_at, hangup_cause: p?.hangup_cause });
        break;
      }

      // (Optional) If Telnyx ever emits explicit transfer/peer leg ids, capture them
      case "call.transfer.initiated":
      case "call.transfer.completed":
      case "call.initiated.outbound":
      case "call.answered.outbound": {
        if (legA && peerLeg) {
          await markBridged({ legA, maybeLegB: peerLeg });
        }
        break;
      }

      default:
        // ignore other noise
        break;
    }
  } catch (e) {
    log("handler error", e?.message);
  }

  // Always ACK fast
  return { statusCode: 200, body: "ok" };
};
