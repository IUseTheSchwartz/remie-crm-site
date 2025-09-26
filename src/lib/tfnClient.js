// src/lib/tfnClient.js
export async function searchTFNs({ prefix = "888", page = 1, size = 25 } = {}) {
  const qs = new URLSearchParams({ prefix, page: String(page), size: String(size) });
  const res = await fetch(`/.netlify/functions/tfn-search?${qs.toString()}`);
  if (!res.ok) throw new Error(`Search failed: ${await res.text()}`);
  return res.json();
}

export async function selectTFN({ userId, phone_number }) {
  const res = await fetch("/.netlify/functions/tfn-select", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
    },
    body: JSON.stringify({ phone_number }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out?.ok) {
    throw new Error(out?.detail || out?.error || `Select failed (${res.status})`);
  }
  return out;
}
