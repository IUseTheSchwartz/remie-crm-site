// File: netlify/functions/twilio-status.js
import { createClient } from "@supabase/supabase-js";

// ---- Supabase (service role needed for server-side updates) ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Charge per SMS segment (1 cent)
const COST_PER_SEGMENT_CENTS = 1;

// Map Twilio status → our internal status (optional tweak)
function mapStatus(twilioStatus) {
  const s = String(twilioStatus || "").toLowerCase();
  if (["queued", "accepted", "scheduled"].includes(s)) return "queued";
  if (["sending"].includes(s)) return "sending";
  if (["sent"].includes(s)) return "sent";
  if (["delivered"].includes(s)) return "delivered";
  if (["failed"].includes(s)) return "failed";
  if (["undelivered"].includes(s)) return "undelivered";
  return s || "unknown";
}

function parseForm(body) {
  // Twilio sends application/x-www-form-urlencoded
  const params = new URLSearchParams(body || "");
  const get = (k) => params.get(k) || "";
  const int = (k, d = 0) => {
    const v = parseInt(params.get(k) || "", 10);
    return Number.isFinite(v) ? v : d;
  };
  return {
    MessageSid: get("MessageSid"),
    MessageStatus: get("MessageStatus"),
    ErrorCode: get("ErrorCode"),
    ErrorMessage: get("ErrorMessage") || get("ErrorMessage__c"),
    NumSegments: int("NumSegments", 1),
    To: get("To"),
    From: get("From"),
  };
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return { statusCode: 400, body: "Expected application/x-www-form-urlencoded" };
    }

    const {
      MessageSid,
      MessageStatus,
      ErrorCode,
      ErrorMessage,
      NumSegments,
    } = parseForm(event.body);

    if (!MessageSid) {
      return { statusCode: 400, body: "Missing MessageSid" };
    }

    // Find our message row by Twilio SID
    const { data: msg, error: selErr } = await supabase
      .from("messages")
      .select("id,user_id,status,segments,price_cents,external_id")
      .eq("external_id", MessageSid)
      .maybeSingle();

    if (selErr) {
      console.error("[twilio-status] select error:", selErr);
      return { statusCode: 500, body: "DB error" };
    }
    if (!msg) {
      // Not found (could be a race or old SID); respond 200 so Twilio doesn't retry forever
      return { statusCode: 200, body: "OK (message not found)" };
    }

    const newStatus = mapStatus(MessageStatus);
    const prevSegments = Number.isFinite(msg.segments) ? msg.segments : 1;
    const prevPrice = Number.isFinite(msg.price_cents) ? msg.price_cents : COST_PER_SEGMENT_CENTS;
    const segNow = Math.max(1, Number(NumSegments) || 1);

    // Update status first (so UI reflects latest state)
    await supabase
      .from("messages")
      .update({
        status: newStatus,
        segments: segNow,
        error_text: ErrorMessage || (ErrorCode ? `Twilio error ${ErrorCode}` : null),
      })
      .eq("id", msg.id);

    // Handle refunds on hard failures
    if (newStatus === "failed" || newStatus === "undelivered") {
      // Refund the initial 1¢ (or whatever we charged so far) if price_cents > 0
      if ((msg.price_cents || 0) > 0) {
        const { data: w } = await supabase
          .from("user_wallets")
          .select("balance_cents")
          .eq("user_id", msg.user_id)
          .maybeSingle();

        if (w) {
          await supabase
            .from("user_wallets")
            .update({ balance_cents: w.balance_cents + (msg.price_cents || 0) })
            .eq("user_id", msg.user_id);
        }

        await supabase
          .from("messages")
          .update({ price_cents: 0 })
          .eq("id", msg.id);
      }

      return { statusCode: 200, body: "OK (refunded on failure)" };
    }

    // If delivered/sent: check if there are EXTRA segments to charge
    if (newStatus === "sent" || newStatus === "delivered") {
      const extraSegments = Math.max(0, segNow - prevSegments);
      if (extraSegments > 0) {
        const extraCost = extraSegments * COST_PER_SEGMENT_CENTS;

        // Try to debit extra from wallet
        const { data: w } = await supabase
          .from("user_wallets")
          .select("balance_cents")
          .eq("user_id", msg.user_id)
          .maybeSingle();

        if (!w) {
          console.warn("[twilio-status] wallet missing for user", msg.user_id);
          // Still update the message so segments/price are correct; your business rule could differ
          await supabase
            .from("messages")
            .update({
              price_cents: prevPrice + extraCost,
            })
            .eq("id", msg.id);

          return { statusCode: 200, body: "OK (wallet missing, recorded usage)" };
        }

        if (w.balance_cents >= extraCost) {
          await supabase
            .from("user_wallets")
            .update({ balance_cents: w.balance_cents - extraCost })
            .eq("user_id", msg.user_id);

          await supabase
            .from("messages")
            .update({
              price_cents: prevPrice + extraCost,
            })
            .eq("id", msg.id);

          return { statusCode: 200, body: "OK (charged extra segments)" };
        } else {
          // Not enough funds for extra segments. Two common choices:
          // A) allow negative (debt) – update message price and set wallet negative
          // B) mark message as 'sent' but note arrears elsewhere
          // C) mark message failed (but it's already sent… usually not ideal)

          // We'll choose A) allow negative to avoid lying about delivery
          await supabase
            .from("user_wallets")
            .update({ balance_cents: w.balance_cents - extraCost })
            .eq("user_id", msg.user_id);

          await supabase
            .from("messages")
            .update({
              price_cents: prevPrice + extraCost,
              error_text: "Wallet below zero after extra segment charge",
            })
            .eq("id", msg.id);

          return { statusCode: 200, body: "OK (charged extra; wallet negative)" };
        }
      }
    }

    return { statusCode: 200, body: "OK" };
  } catch (e) {
    console.error("[twilio-status] error:", e);
    return { statusCode: 500, body: "Internal error" };
  }
};
