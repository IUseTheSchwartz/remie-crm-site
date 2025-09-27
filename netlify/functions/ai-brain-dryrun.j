// File: netlify/functions/ai-brain-dryrun.js
// Exposes your ai-brain's decide() over HTTP so AdminConsole can test without sending SMS.

const { decide } = require("./ai-brain.js"); // adjust if your brain file name/path differs

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json({ ok: false, error: "POST only" }, 405);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return json({ ok: false, error: "invalid_json" }, 400); }

    const { text, agentName, calendlyLink, tz, officeHours } = payload || {};
    if (!text) {
      return json({ ok: false, error: "Missing text" }, 400);
    }

    const result = decide({
      text,
      agentName: agentName || "Agent",
      calendlyLink: calendlyLink || null,
      tz: tz || "America/Chicago",
      officeHours: officeHours || { start: 9, end: 21 },
    });

    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Failed" }, 500);
  }
};
