// netlify/functions/sync-admin-allowlist.js
import { createClient } from "@supabase/supabase-js";
import { SUPPORT_ADMIN_EMAILS } from "../../src/config/supportAdmins.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

export const handler = async () => {
  try {
    const rows = SUPPORT_ADMIN_EMAILS.map((email) => ({
      email: email.toLowerCase().trim(),
    }));

    const { error } = await supabase
      .from("admin_allowlist")
      .upsert(rows, { onConflict: "email" });
    if (error) throw error;

    // Remove emails no longer in the file (keeps DB in sync)
    const { data: existing, error: listErr } = await supabase
      .from("admin_allowlist")
      .select("email");
    if (listErr) throw listErr;

    const fileSet = new Set(rows.map((r) => r.email));
    const toDelete = (existing || [])
      .map((r) => r.email)
      .filter((e) => !fileSet.has(e));

    if (toDelete.length) {
      const { error: delErr } = await supabase
        .from("admin_allowlist")
        .delete()
        .in("email", toDelete);
      if (delErr) throw delErr;
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
