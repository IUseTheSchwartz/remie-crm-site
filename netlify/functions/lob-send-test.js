// Debug-friendly version: surfaces precise errors in the response
export async function handler(event) {
  try {
    // Quick GET probe so you can hit the URL in a browser and confirm it's live
    if (event.httpMethod === "GET") {
      const hasKey = !!process.env.LOB_API_KEY;
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body:
          "lob-send-test is live.\n" +
          `Method: GET ok\n` +
          `Env(L0B_API_KEY present): ${hasKey}\n` +
          `POST JSON to this endpoint to create a test postcard or letter.`,
      };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    // 1) Check env var is present
    const apiKey = process.env.LOB_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: "Missing LOB_API_KEY (set it in Netlify env vars and redeploy)" };
    }

    // 2) Parse body safely and validate
    let bodyRaw = event.body || "";
    let payload;
    try {
      payload = JSON.parse(bodyRaw);
    } catch (e) {
      return {
        statusCode: 400,
        body: `Invalid JSON body. Error: ${e.message}. Raw body: ${bodyRaw.slice(0, 200)}`
      };
    }

    const { type = "postcard", to, from, vars = {} } = payload;
    if (!to || !from) {
      return { statusCode: 400, body: "Missing 'to' or 'from' object in JSON body" };
    }

    // 3) Build addresses (Lob expects these property names)
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

    // 4) Minimal HTML templates (fine for Test mode)
    const pcFront = `<html><body style="width:6in;height:4in;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font-family:sans-serif">
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:700">Welcome to the Family</div>
        <div style="font-size:14px;opacity:.8">{{firstName}}, your policy {{policyNumber}} is active.</div>
      </div></body></html>`;
    const pcBack = `<html><body style="width:6in;height:4in;font-family:sans-serif">
      <div style="padding:.5in">
        <p>Hi {{firstName}},</p>
        <p>Thanks for choosing us. Your policy <b>{{policyNumber}}</b> is now active.</p>
        <p>We’re here if you need anything!</p>
        <p style="margin-top:24px">– Your Agent</p>
      </div></body></html>`;
    const letterHtml = `<html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.4">
      <div style="padding:1in">
        <h1 style="margin:0 0 12px">Welcome, {{firstName}}!</h1>
        <p>Your policy <b>{{policyNumber}}</b> is now active.</p>
        <p>This letter confirms your coverage. Keep it for your records.</p>
        <p style="margin-top:24px">Sincerely,<br/>Your Agency</p>
      </div></body></html>`;

    // 5) Call Lob REST API (no SDK needed)
    const authHeader = "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
    const endpoint = type === "letter" ? "https://api.lob.com/v1/letters" : "https://api.lob.com/v1/postcards";

    const lobBody =
      type === "letter"
        ? { to: toAddr, from: fromAddr, file: letterHtml, merge_variables: vars, color: true }
        : { to: toAddr, from: fromAddr, size: "4x6", front: pcFront, back: pcBack, merge_variables: vars };

    // Ensure fetch exists (Netlify Functions on Node 18+ has it)
    if (typeof fetch !== "function") {
      return { statusCode: 500, body: "fetch is not defined in this runtime" };
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(lobBody),
    });

    const text = await resp.text();
    if (!resp.ok) {
      // Return Lob's exact error body to help diagnose (e.g., invalid address)
      return { statusCode: resp.status, body: `Lob error: ${text}` };
    }

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
    // Return full error details so we can see what's happening
    return {
      statusCode: 500,
      body: `Server error: ${err?.message || err}\n${err?.stack || ""}`.slice(0, 2000)
    };
  }
}
