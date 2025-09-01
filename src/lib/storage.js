// File: src/lib/storage.js

// LocalStorage keys (swap to Supabase later)
const KEYS = {
  leads: "remie_leads_v1",           // raw leads / prospects
  clients: "remie_clients_v1",       // unified list (leads + sold)
  leadsApiKey: "remie_leads_api_key_v1", // NEW: vendor API key for auto-import
};

/* ---------------------------
   Basic load/save helpers
----------------------------*/
export function loadLeads() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.leads)) || [];
  } catch {
    return [];
  }
}
export function saveLeads(leads) {
  localStorage.setItem(KEYS.leads, JSON.stringify(leads));
}

export function loadClients() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.clients)) || [];
  } catch {
    return [];
  }
}
export function saveClients(clients) {
  localStorage.setItem(KEYS.clients, JSON.stringify(clients));
}

/* ---------------------------
   API Key helpers (NEW)
----------------------------*/
export function loadLeadsApiKey() {
  try {
    return localStorage.getItem(KEYS.leadsApiKey) || "";
  } catch {
    return "";
  }
}
export function saveLeadsApiKey(value = "") {
  if (typeof value !== "string") value = String(value ?? "");
  localStorage.setItem(KEYS.leadsApiKey, value.trim());
}
export function clearLeadsApiKey() {
  localStorage.removeItem(KEYS.leadsApiKey);
}

/* ---------------------------
   Shape normalizer

   Person:
   {
     id: string,
     name: string,
     phone: string,
     email: string,
     status: "lead" | "sold",
     notes?: string,
     dob?: string,
     state?: string,
     beneficiary?: string,
     beneficiary_name?: string,
     company?: string,
     gender?: string,
     sold?: {
       carrier: string,
       faceAmount: string|number,
       premium: string|number,
       monthlyPayment: string|number,
       policyNumber?: string, // NEW field supported
       effectiveDate?: string,
       notes?: string,
       address?: {
         street: string,
         city: string,
         state: string,
         zip: string,
       }
     } | null
   }
----------------------------*/
export function normalizePerson(p = {}) {
  const sold = p.sold || null;

  // Allow/keep extra lead fields if present
  const keep = {
    notes: p.notes ?? "",
    dob: p.dob ?? "",
    state: p.state ?? "",
    beneficiary: p.beneficiary ?? "",
    beneficiary_name: p.beneficiary_name ?? "",
    company: p.company ?? "",
    gender: p.gender ?? "",
  };

  return {
    id:
      p.id ||
      (typeof crypto !== "undefined"
        ? crypto.randomUUID()
        : String(Date.now())),
    name: p.name || "",
    phone: p.phone || p.number || "",
    email: p.email || "",
    status: p.status === "sold" ? "sold" : "lead",
    ...keep,
    sold: sold
      ? {
          carrier: sold.carrier || "",
          faceAmount: sold.faceAmount || "",
          premium: sold.premium || "",
          monthlyPayment: sold.monthlyPayment || "",
          policyNumber: sold.policyNumber || "",
          effectiveDate: sold.effectiveDate || "",
          notes: sold.notes || "",
          address: {
            street: sold.address?.street || "",
            city: sold.address?.city || "",
            state: sold.address?.state || "",
            zip: sold.address?.zip || "",
          },
        }
      : null,
  };
}

/* ---------------------------
   Upsert utility (merge by id)
----------------------------*/
export function upsert(arr = [], person = {}) {
  const item = normalizePerson(person);
  const idx = arr.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...arr, item];

  // Merge existing with new (favor new truthy values)
  const prev = arr[idx];
  const next = {
    ...prev,
    ...item,
    sold: item.sold ?? prev.sold ?? null,
  };
  const copy = [...arr];
  copy[idx] = next;
  return copy;
}

/* ---------------------------
   Merge array of persons
----------------------------*/
export function merge(arr = [], incoming = []) {
  let next = [...arr];
  for (const p of incoming) {
    next = upsert(next, p);
  }
  return next;
}

/* ---------------------------
   Optional utilities
----------------------------*/
export function removeById(arr = [], id) {
  return arr.filter((x) => x.id !== id);
}

export function clearAllLocal() {
  localStorage.removeItem(KEYS.leads);
  localStorage.removeItem(KEYS.clients);
  localStorage.removeItem(KEYS.leadsApiKey); // include API key in full clear
}
