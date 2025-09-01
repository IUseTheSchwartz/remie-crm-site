import { createClient } from "@supabase/supabase-js";
const ENDPOINT = { letter: "https://api.lob.com/v1/letters", postcard: "https://api.lob.com/v1/postcards" };
const auth = () => "Basic " + Buffer.from(`${process.env.LOB_API_KEY}:`).toString("base64");

export async function handler() {
  try {
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: jobs, error } = await admin
      .from("mail_jobs")
      .select("id,user_id,lead_id,type,payload")
      .eq("status","queued")
      .order("created_at",{ascending:true})
      .limit(10);
    if (error) return { statusCode: 500, body: "DB error: " + error.message };
    if (!jobs?.length) return { statusCode: 200, body: "no queued jobs" };

    const leadIds = jobs.map(j=>j.lead_id);
    const { data: leads, error: lerr } = await admin
      .from("leads").select("id,name,sold").in("id", leadIds);
    if (lerr) return { statusCode: 500, body: "Lead fetch error: " + lerr.message };
    const leadMap = new Map(leads.map(l => [l.id, l]));

    const pcFront = `<html><body style="width:6in;height:4in;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font-family:sans-serif"><div style="text-align:center"><div style="font-size:28px;font-weight:700">Welcome</div><div style="font-size:14px;opacity:.8">{{firstName}}, policy {{policyNumber}} is active.</div></div></body></html>`;
    const pcBack  = `<html><body style="width:6in;height:4in;font-family:sans-serif"><div style="padding:.5in"><p>Hi {{firstName}},</p><p>Your policy <b>{{policyNumber}}</b> is active.</p><p>We’re here if you need anything!</p><p style="margin-top:24px">– Your Agent</p></div></body></html>`;
    const letter  = `<html><body style="font-family:Arial,sans-serif"><div style="padding:1in"><h1>Welcome, {{firstName}}!</h1><p>Your policy <b>{{policyNumber}}</b> is active.</p><p>Keep this letter for your records.</p><p style="margin-top:24px">Sincerely,<br/>Your Agency</p></div></body></html>`;

    const updates = [];
    for (const j of jobs) {
      const lead = leadMap.get(j.lead_id);
      if (!lead) { updates.push({ id: j.id, status: "failed", error: "Lead not found" }); continue; }

      const addr = lead.sold?.address || {};
      if (!addr.street || !addr.city || !addr.state || !addr.zip) {
        updates.push({ id: j.id, status: "failed", error: "Missing sold.address fields" }); continue;
      }

      const to = { name: lead.name || "Customer", address_line1: addr.street, address_city: addr.city, address_state: addr.state, address_zip: addr.zip, address_country: "US" };
      const from = { name: "Your Agency", address_line1: "123 Agency Ave", address_city: "Dallas", address_state: "TX", address_zip: "75201", address_country: "US" };

      const vars = { firstName: (lead.name||"").split(" ")[0] || "Customer", policyNumber: lead.sold?.policyNumber || "", ...(j.payload||{}) };

      let endpoint, body;
      if (j.type === "welcome_policy_letter") {
        endpoint = ENDPOINT.letter; body = { to, from, file: letter, merge_variables: vars, color: true };
      } else if (j.type === "birthday_postcard" || j.type === "holiday_card") {
        endpoint = ENDPOINT.postcard; body = { to, from, size: "4x6", front: pcFront, back: pcBack, merge_variables: vars };
      } else {
        updates.push({ id: j.id, status: "failed", error: "Unknown type" }); continue;
      }

      try {
        const resp = await fetch(endpoint, { method: "POST", headers: { Authorization: auth(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const text = await resp.text();
        if (!resp.ok) throw new Error(text);
        const data = JSON.parse(text);
        updates.push({ id: j.id, status: "sent", vendor_id: data.id, error: null });
      } catch (e) {
        updates.push({ id: j.id, status: "failed", error: String(e).slice(0, 500) });
      }
    }

    for (const u of updates) {
      await admin.from("mail_jobs").update({
        status: u.status, vendor_id: u.vendor_id || null, error: u.error || null,
        updated_at: new Date().toISOString()
      }).eq("id", u.id);
    }

    return { statusCode: 200, body: `processed ${updates.length} job(s)` };
  } catch (e) {
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
