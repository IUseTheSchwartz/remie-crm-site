// Quick CLI harness for ./ai-brain.js
// Run: node test-brain.js
// Or:  node test-brain.js "who's this?"

const { decide } = require("./ai-brain");

const defaults = {
  agentName: "Jacob Prieto",
  calendlyLink: "https://calendly.com/your-link/15min",
  tz: "America/Chicago",
  officeHours: { start: 9, end: 21 },
};

const samples = [
  "hi",
  "who's this?",
  "how much is it?",
  "i already have coverage",
  "not interested, busy",
  "wrong number",
  "can you call me",
  "tomorrow afternoon",
  "10:30 am works",
  "reschedule to a different time",
  "sí, podemos",
];

function runOne(text) {
  const out = decide({ text, ...defaults });
  console.log("\n> IN :", JSON.stringify(text));
  console.log("  INT:", out.intent);
  console.log("  OUT:", out.text);
}

if (process.argv[2]) {
  runOne(process.argv.slice(2).join(" "));
} else {
  samples.forEach(runOne);
}
