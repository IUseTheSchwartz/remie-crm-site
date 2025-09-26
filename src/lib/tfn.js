// src/lib/tfn.js
export async function selectTollFree(userId, payload) {
  const res = await fetch("/.netlify/functions/tfn-select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, ...payload }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { parse_error: true, raw: text }; }

  if (!res.ok || json?.error) {
    console.error("[tfn-select error]", { status: res.status, json });
    throw new Error(json?.error || `HTTP_${res.status}`);
  }

  console.log("[tfn-select ok]", json);
  return json;
}
