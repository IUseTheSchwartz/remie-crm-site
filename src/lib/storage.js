// File: src/lib/storage.js

// LocalStorage keys (swap to Supabase later)
const KEYS = {
  leads: "remie_leads_v1",     // raw leads / prospects
  clients: "remie_clients_v1", // unified list (leads + sold)
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
   Shape normalizer

   Person:
   {
     id: string,
     name: string,
     phone: string,
     email: string,
     status: 'lead' | 'sold',

     // --- Extra lead attributes ---
     dob: string,                    // e.g. "1990-05-12" or "05/12/1990"
     state: string,                  // two-letter or full
     gender: string,                 // "Male" | "Female" | "Other" | ""
     beneficiary: string,            // yes/no/relationship
     beneficiaryName: string,        // name of beneficiary
     notes: string,

     sold: {
       carrier: string,
       faceAmount: string|number,
       premium: string|number,
       monthlyPayment: string|number,
       startDate: string,            // YYYY-MM-DD
       policyNumber: string,         // NEW
       name: string,                 // snapshot at sale time
       phone: string,
       email: string,
       address: {
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

  return {
    id: p.id || (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now())),
    name: (p.name ?? "").trim(),
    phone: (p.phone ?? p.number ?? "").trim(),
    email: (p.email ?? "").trim(),
    status: p.status === "sold" ? "sold" : "lead",

    // Extra lead attributes (keep if present; default to empty)
    dob: (p.dob ?? "").trim(),
    state: (p.state ?? "").trim(),
    gender: (p.gender ?? "").trim(),
    beneficiary: (p.beneficiary ?? "").trim(),
    beneficiaryName: (p.beneficiaryName ?? "").trim(),
    notes: (p.notes ?? "").trim(),

    sold: sold
      ? {
          carrier: (sold.carrier ?? "").trim(),
          faceAmount: sold.faceAmount ?? "",
          premium: sold.premium ?? "",
          monthlyPayment: sold.monthlyPayment ?? "",
          startDate: (sold.startDate ?? "").trim(),
          policyNumber: (sold.policyNumber ?? "").trim(), // NEW

          // snapshot of identity at sale time, falling back to top-level
          name: (sold.name ?? p.name ?? "").trim(),
          phone: (sold.phone ?? p.phone ?? p.number ?? "").trim(),
          email: (sold.email ?? p.email ?? "").trim(),

          address: {
            street: (sold.address?.street ?? "").trim(),
            city: (sold.address?.city ?? "").trim(),
            state: (sold.address?.state ?? "").trim(),
            zip: (sold.address?.zip ?? "").trim(),
          },
        }
      : null,
  };
}

/* ---------------------------
   Array upsert by id
----------------------------*/
export function upsert(arr = [], obj = {}) {
  const normalized = normalizePerson(obj);
  const next = [...arr];
  const i = next.findIndex((x) => x.id === normalized.id);
  if (i >= 0) next[i] = { ...next[i], ...normalized };
  else next.unshift(normalized);
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
}
