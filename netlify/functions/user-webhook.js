// Creates/gets a per-user webhook (and rotates on POST {rotate:true})
// Assumes you authenticate requests server-side and know the current user_id.
const { getServiceClient, getUserFromRequest } = require("./_supabase");
const crypto = require("crypto");
const supabase = getServiceClient();

exports.handler = async (event) => {
  // get current user from Authorization header (JWT)
  const user = await getUserFromRequest({
    headers: new Map(Object.entries(event.headers || {})),
  });
  if (!user) return { statusCode: 401, body: "Unauthorized" };

  const userId = user.id;
  try {
    if (event.httpMethod === "GET") {
      const { data } = await supabase
        .from("user_inbound_webhooks")
        .select("id, secret")
        .eq("user_id", userId)
        .eq("active", true)
        .limit(1);

      if (data && data.length) {
        return { statusCode: 200, body: JSON.stringify(data[0]) };
      }

      const id = `wh_${crypto.randomBytes(8).toString("hex")}`;
      const secret = crypto.randomBytes(32).toString("base64");
      const { error } = await supabase.from("user_inbound_webhooks").insert([
        { id, user_id: userId, secret, active: true },
      ]);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ id, secret }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (!body.rotate) return { statusCode: 400, body: "Bad request" };
      const secret = crypto.randomBytes(32).toString("base64");
      const { data, error } = await supabase
        .from("user_inbound_webhooks")
        .update({ secret })
        .eq("user_id", userId)
        .eq("active", true)
        .select("id, secret")
        .limit(1);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify(data[0]) };
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Server error" };
  }
};
