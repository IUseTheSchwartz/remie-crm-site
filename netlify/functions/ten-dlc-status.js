// File: netlify/functions/ten-dlc-status.js
const { getServiceClient } = require("./_supabase"); // you already have this helper

exports.handler = async (event) => {
  try {
    const authz = event.headers.authorization || event.headers.Authorization || "";
    const token = (authz.startsWith("Bearer ") ? authz.slice(7) : "").trim();
    if (!token) return json({ ok: false, error: "Missing auth token" }, 401);

    const supabase = getServiceClient();

    // Get the authed user (from JWT the front-end sends)
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) return json({ ok: false, error: "Auth failed" }, 401);
    const userId = userData.user.id;

    // Look up the user's assigned 10DLC number
    const { data: row, error } = await supabase
      .from("ten_dlc_numbers")
      .select("phone_number, verified")
      .eq("assigned_to", userId)
      .maybeSingle();

    if (error) return json({ ok: false, error: error.message }, 500);

    if (!row) return json({ ok: true, phone_number: null, verified: false });
    return json({ ok: true, phone_number: row.phone_number, verified: !!row.verified });
  } catch (e) {
    return json({ ok: false, error: e.message || "Server error" }, 500);
  }
};

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
