// File: netlify/functions/lob-send-test.js
// ESM style to match your repo
import Lob from "lob";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.LOB_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: "Missing LOB_API_KEY" };
    }
    const lob = new Lob(apiKey);

    // Body schema:
    // {
    //   "type": "postcard" | "letter",   // default "postcard"
    //   "to":   { name, address_line1, address_line2?, city, state, zip, country? },
    //   "from": { name, address_line1, address_line2?, city, state, zip, country? },
    //   "vars": { firstName, policyNumber, ... }  // optional merge vars for templates
    // }
    const { type = "postcard", to, from, vars = {} } = JSON.parse(event.body || "{}");

    if (!to || !from) {
      return { statusCode: 400, body: "Missing required 'to' or 'from' address" };
    }

    // Very simple HTML templates for testing
    const pcFront = `
      <html style="padding:0;margin:0;">
        <body style="padding:0;margin:0;width:6in;height:4in;display:flex;align-items:center;justify-content:center;font-family:sans-serif;background:#111;color:#fff;">
          <div style="text-align:center;">
            <div style="font-size:28px;font-weight:700;">Welcome to the Family</div>
            <div style="font-size:14px;opacity:.8;">{{firstName}}, your policy {{policyNumber}} is active.</div>
          </div>
        </body>
      </html>`;

    const pcBack = `
      <html style="padding:0;margin:0;">
        <body style="padding:0;margin:0;width:6in;height:4in;font-family:sans-serif;">
          <div style="padding:.5in;">
            <p>Hi {{firstName}},</p>
            <p>Thanks for choosing us. Your policy <b>{{policyNumber}}</b> is now active.</p>
            <p>We're here if you need anything!</p>
            <p style="margin-top:24px;">– Your Agent</p>
          </div>
        </body>
      </html>`;

    const letterHtml = `
      <html>
        <head><meta charset="utf-8" /></head>
        <body style="font-family:Arial, Helvetica, sans-serif; color:#111; line-height:1.4;">
          <div style="padding:1in;">
            <h1 style="margin:0 0 12px;">Welcome, {{firstName}}!</h1>
            <p>We’re happy to share that your policy <b>{{policyNumber}}</b> is now active.</p>
            <p>This letter confirms your coverage. Keep it for your records.</p>
            <p style="margin-top:24px;">Sincerely,<br/>Your Agency</p>
          </div>
        </body>
      </html>`;

    // Build addresses (Lob accepts either a full object or an address_id)
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

    let result;

    if (type === "letter") {
      // Send a 1-page color letter
      result = await lob.letters.create({
        to: toAddr,
        from: fromAddr,
        file: letterHtml,
        merge_variables: vars,
        color: true,
      });
    } else {
      // Default: send a 4x6 postcard
      result = await lob.postcards.create({
        to: toAddr,
        from: fromAddr,
        size: "4x6",
        front: pcFront,
        back: pcBack,
        merge_variables: vars,
      });
    }

    // Return useful info (URLs are PDFs in Test Mode)
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: result.id,
        url: result.url || result.thumbnails?.[0]?.url || null,
        expected_delivery_date: result.expected_delivery_date || null,
        preview_pdf: result?.urls?.pdf || null,
      }),
    };
  } catch (err) {
    console.error("lob-send-test error:", err);
    const msg = err?.response?.body || err?.message || "Server error";
    return { statusCode: 500, body: typeof msg === "string" ? msg : JSON.stringify(msg) };
  }
}
