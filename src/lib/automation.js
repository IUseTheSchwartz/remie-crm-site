// File: src/lib/automation.js

// ---------------------------------------------------------------------------
// Minimal local "queue" (dev-only preview; does NOT actually send SMS)
// ---------------------------------------------------------------------------
const KEY = "remie_automation_queue_v1";

export function loadQueue() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
}
export function saveQueue(q) {
  localStorage.setItem(KEY, JSON.stringify(q));
}
export function enqueue(task) {
  const q = loadQueue();
  q.unshift({
    id: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)),
    createdAt: new Date().toISOString(),
    status: "queued", // "queued" | "sent" | "failed"
    ...task,
  });
  saveQueue(q);
  return q[0];
}

// ---------------------------------------------------------------------------
// Real senders (via Netlify functions) — SMS only
// ---------------------------------------------------------------------------
const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";
import { supabase } from "./supabaseClient";

/** Internal helper to call the Netlify messages-send function. */
async function postMessagesSend(payload) {
  const { data: { session } = {} } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${FN_BASE}/messages-send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  let out = {};
  try { out = await res.json(); } catch {}
  if (!res.ok) {
    console.warn("[messages-send] non-OK", res.status, out);
  } else {
    console.log("[messages-send] ok", out);
  }
  return { ok: res.ok, status: res.status, data: out };
}

/**
 * Send the SOLD policy info text (templateKey: 'sold_policy').
 * Ensure your message_templates row has:
 *   enabled.sold_policy = true
 *   templates.sold_policy = "<your text with placeholders>"
 *
 * Placeholders supported by the server:
 *   first_name, carrier, face_amount, policy_number,
 *   monthly_payment, policy_start_date
 */
export async function sendSoldPolicyText({ leadId, userId, phone, sold, name }) {
  const first_name = String(name || "").trim().split(/\s+/)[0] || "";

  const placeholders = {
    first_name,
    carrier: sold?.carrier || "",
    face_amount: sold?.faceAmount || sold?.face_amount || "",
    policy_number: sold?.policyNumber || sold?.policy_number || "",
    monthly_payment: sold?.monthlyPayment || sold?.monthly_payment || "",
    policy_start_date: sold?.startDate || sold?.policy_start_date || "",
  };

  // Prefer passing lead_id so the function can hydrate more fields.
  return postMessagesSend({
    templateKey: "sold_policy",
    lead_id: leadId,
    user_id: userId,
    to: phone,
    placeholders,
  });
}

// ---------------------------------------------------------------------------
// Legacy dev helper (kept so existing calls don’t break)
// NOTE: This is LOCAL PREVIEW ONLY (does not send via Telnyx).
// ---------------------------------------------------------------------------
export function scheduleWelcomeText({ name, phone, carrier, startDate }) {
  if (!phone) return;
  return enqueue({
    kind: "sms",
    to: phone,
    meta: { name, carrier, startDate },
    body:
      `Hi ${name || "there"} — congratulations on your new policy! ` +
      `Carrier: ${carrier || "TBD"}. Start date: ${startDate || "TBD"}. ` +
      `Reply here with any questions. — Remie CRM`,
  });
}
