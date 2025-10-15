// netlify/functions/_phone.js  (CommonJS so functions can require it)
function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

// Convert common US inputs to E.164. Keeps +E.164 as-is. Returns null if invalid.
function toE164(raw, { defaultCountry = "US" } = {}) {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (s.startsWith("+")) {
    const d = onlyDigits(s);
    return d ? `+${d}` : null;
  }

  const d = onlyDigits(s);
  if (defaultCountry === "US") {
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  }

  if (d.length >= 11) return `+${d}`;
  return null;
}

module.exports = { toE164, onlyDigits };
