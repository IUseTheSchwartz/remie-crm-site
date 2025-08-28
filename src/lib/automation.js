// File: src/lib/automation.js

const KEY = "remie_automation_queue_v1";

/**
 * Simple local queue so you can see what would be sent.
 * Later, replace these with calls to your serverless functions
 * that hit Twilio / SendGrid / Lob, etc.
 */
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
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "queued", // "queued" | "sent" | "failed"
    ...task,
  });
  saveQueue(q);
  return q[0];
}

/**
 * Template: welcome text after sale
 */
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

/**
 * Template: policy kickoff email / printable letter
 */
export function schedulePolicyKickoffEmail({ name, email, carrier, faceAmount, monthlyPayment, startDate, address }) {
  if (!email && !address) return; // need at least one channel

  const subject = `Your ${carrier || ""} policy details`;
  const text =
    `Hi ${name || "there"},\n\n` +
    `Welcome! Your policy details are below:\n` +
    `• Carrier: ${carrier || "TBD"}\n` +
    `• Face Amount: ${faceAmount || "TBD"}\n` +
    `• Monthly Payment: ${monthlyPayment || "TBD"}\n` +
    `• Policy Start Date: ${startDate || "TBD"}\n\n` +
    `We're here if you need anything!\n— Remie CRM`;

  return enqueue({
    kind: "email_or_letter",
    to: email || `${address?.street}, ${address?.city}, ${address?.state} ${address?.zip}`,
    meta: { name, carrier, faceAmount, monthlyPayment, startDate, address },
    subject,
    body: text,
  });
}

/**
 * Later, replace with real senders:
 *  - Twilio Programmable SMS for `sms`
 *  - Resend/SendGrid/Postmark for `email`
 *  - Lob.com for `letters` (print & mail)
 */
