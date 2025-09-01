// ESM Netlify function that hits Lob's REST API directly (no SDK needed)
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.LOB_API_KEY;
    if (!apiKey) return { statusCode: 500, body: "Missing LOB_API_KEY" };

    const { type = "postcard", to, from, vars = {} } = JSON.parse(event.body || "{}");
    if (!to || !from) return { statusCode: 400, body: "Missing 'to' or 'from' address" };

    const toAddr = {
      name: to.name,
      address_line1: to.address_line1,
      address_line2: to.address_line2 || undefined,
      address_city: to.city,
      address_state: to.state,
      address_zip: to.zip,
      address_country: to.country || "US",
    };
    const fromAddr = {
      name: from.name,
      address_line1: from.address_line1,
      address_line2: from.address_line2 || undefined,
      address_city: from.city,
      address_state: from.state,
      address_zip: from.zip,
      address_country: from.country || "US",
    };

    const pcFront = `
      <html><body style="width:6in;height:4in;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font-family:sans-serif">
        <div style="text-align:center">
          <div style="font-size:28px;font-weight:700">Welcome to the Family</div>
          <div style="font-size:14px;opacity:.8">{{firstName}}, your policy {{policyNumber}} is active.</div>
        </div>
      </body></html>`;
    const pcBack = `
      <html><body style="width:6in;height:4in;font-family:sans-serif">
        <div style="padding:.5in">
          <p>Hi {{firstName}},</p>
          <p>Thanks for choosing us. Your policy <b>{{policyNumber}}</b> is now active.</p>
          <p>We’re here if you need anything!</p>
          <p style="margin-top:24px">– Your Agent</p>
        </div>
      </body></html>`;
    const letterHtml = `
      <html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.4">
        <div style="padding:1in">
          <h1 style="margin:0 0 12px">Welcome, {{firstName}}!</h1>
          <p>Your policy <b>{{policyNumber}}</b> is now active.</p>
          <p>This letter confirms your coverage. Keep it for your records.</p>
          <p style="margin-top:24px">Sincerely,<br/>Your Agency</p>
        </div>
      </body></html>`;

    const authHeader = "Basic " + Buffer.from(`${apiKey}:`).toString("base64");

    const endpoint =
      type === "letter" ? "https://api.lob.com/v1/letters" : "https://api.lob.com/v1/postcards";

    const body =
      type === "letter"
        ? {
            to: toAddr,
            from: fromAddr,
            file: letterHtml,
            merge_variables: vars,
            color: true,
          }
        : {
            to: toAddr,
            from: fromAddr,
            size: "4x6",
            front: pcFront,
            back: pcBack,
            merge_variables: vars,
          };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    if (!resp.ok) {
      // Pass through Lob's error body so you can see what's wrong
      return { statusCode: resp.status, body: text };
    }

    // Success: return useful fields
    const data = JSON.parse(text);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: data.id,
        preview_pdf: data?.urls?.pdf || null,
        expected_delivery_date: data.expected_delivery_date || null,
        thumbnails: data.thumbnails || null,
      }),
    };
  } catch (err) {
    console.error("lob-send-test error:", err);
    return { statusCode: 500, body: err?.message || "Server error" };
  }
}
