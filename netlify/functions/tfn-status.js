// netlify/functions/tfn-status.js
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const user = await getUserFromRequest(event);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("toll_free_numbers")
      .select("phone_number, verified")
      .eq("assigned_to", user.id)
      .maybeSingle();

    if (error) throw error;

    return json({
      ok: true,
      phone_number: data?.phone_number || null,
      verified: !!data?.verified,
    });
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};
