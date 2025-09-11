// File: netlify/lib/supabase.js
// CommonJS re-export of your existing service client.
// Usage in other functions/libs:
//   const supabase = require("../lib/supabase");
//   // or, if you prefer the factory:
//   const { getServiceClient } = require("../lib/supabase");

const { getServiceClient } = require("../functions/_supabase.js");

// Create a singleton for most callers
const supabase = getServiceClient();

module.exports = supabase;
// Also expose the factory for advanced use
module.exports.getServiceClient = getServiceClient;
