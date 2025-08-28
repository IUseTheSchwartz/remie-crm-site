// File: src/lib/storage.js

const KEYS = {
  leads: "remie_leads_v1",     // raw leads (potential clients)
  clients: "remie_clients_v1", // master client list (includes leads + sold, if you want)
};

export function loadLeads() {
  try { return JSON.parse(localStorage.getItem(KEYS.leads)) || []; }
  catch { return []; }
}
export function saveLeads(leads) {
  localStorage.setItem(KEYS.leads, JSON.stringify(leads));
}

export function loadClients() {
  try { return JSON.parse(localStorage.getItem(KEYS.clients)) || []; }
  catch { return []; }
}
export function saveClients(clients) {
  localStorage.setItem(KEYS.clients, JSON.stringify(clients));
}

/**
 * Ensure a lead/client object has a consistent shape.
 * id: string
 * name, phone, email
 * status: 'lead' | 'sold'
 * sold: { carrier, faceAmount, premium, monthlyPayment, startDate }
 */
export function normalizePerson(p = {}) {
  return {
    id: p.id || crypto.randomUUID(),
    name: p.name || "",
    phone: p.phone || p.number || "",
    email: p.email || "",
    status: p.status || "lead",
    sold: p.sold || null,
  };
}

// Upsert into an array by id
export function upsert(arr, obj) {
  const idx = arr.findIndex((x) => x.id === obj.id);
  if (idx >= 0) arr[idx] = obj;
  else arr.unshift(obj);
  return [...arr];
}
