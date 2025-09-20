// File: src/lib/phone.js

export const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");

/** Convert common US inputs to E.164. Keeps +E.164 as-is. Returns null if invalid. */
export const toE164 = (raw, { defaultCountry = "US" } = {}) => {
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

  // Fallback: treat >=11 digits as an intl number missing '+'
  if (d.length >= 11) return `+${d}`;

  return null;
};

/** Last 10 digits for loose matching (US-centric). */
export const last10 = (s) => {
  const d = onlyDigits(s);
  return d.slice(-10);
};
