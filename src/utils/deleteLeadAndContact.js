// File: src/utils/deleteLeadAndContact.js
import { supabase } from "../lib/supabaseClient";

/**
 * Delete a lead and any matching contact entries by phone (common variants).
 * - Looks up the lead's phone
 * - Deletes the lead
 * - Deletes message_contacts rows with matching phone variants
 */
export async function deleteLeadAndContact(leadId, userId) {
  if (!leadId || !userId) throw new Error("leadId and userId are required");

  // 1) Look up the lead to get phone (before deleting)
  const { data: lead, error: getErr } = await supabase
    .from("leads")
    .select("id, phone")
    .eq("id", leadId)
    .eq("user_id", userId)
    .maybeSingle();

  if (getErr) throw getErr;

  // 2) Delete the lead
  const { error: delLeadErr } = await supabase
    .from("leads")
    .delete()
    .eq("id", leadId)
    .eq("user_id", userId);

  if (delLeadErr) throw delLeadErr;

  // 3) Delete matching contact(s) by phone variants
  const phone = (lead?.phone || "").trim();
  if (!phone) return; // nothing else to do if no phone

  const digits = phone.replace(/\D/g, "");
  const ten =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.slice(-10);

  const variants = Array.from(
    new Set([phone, ten, `1${ten}`, `+1${ten}`].filter(Boolean))
  );

  const { error: delContactsErr } = await supabase
    .from("message_contacts")
    .delete()
    .eq("user_id", userId)
    .in("phone", variants);

  if (delContactsErr) throw delContactsErr;
}
