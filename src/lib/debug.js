// Simple client logger + ring buffer + global toggle.
// Use: import { debug } from "../lib/debug";
const KEY = "debug:remie";
let enabled = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) || "false"); } catch { return false; }
})();
const queue = [];
function keep(item) {
  queue.push(item);
  if (queue.length > 500) queue.shift();
  // expose for quick inspection
  window.__remieDebugQueue = queue;
}
function setEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem(KEY, JSON.stringify(enabled)); } catch {}
}
function stamp(type, args) {
  return { ts: new Date().toISOString(), type, args };
}
function out(method, ...args) {
  keep(stamp(method, args));
  if (!enabled) return;
  const c = method === "error" ? console.error
          : method === "warn"  ? console.warn
          : console.log;
  c("[remie]", ...args);
}
function on() { setEnabled(true); }
function off() { setEnabled(false); }
function toggle() { setEnabled(!enabled); }
function get() { return queue.slice(); }
function clear() { queue.length = 0; keep(stamp("log", ["(cleared)"])); }
export const debug = {
  on, off, toggle, get, clear,
  enabled: () => enabled,
  log:  (...a) => out("log",  ...a),
  warn: (...a) => out("warn", ...a),
  error:(...a) => out("error",...a),
};

// Global listeners
if (typeof window !== "undefined" && !window.__remieDebugInstalled) {
  window.__remieDebugInstalled = true;
  window.addEventListener("error", (e) => debug.error("window.error", e.message, e.filename, e.lineno, e.colno));
  window.addEventListener("unhandledrejection", (e) => debug.error("unhandledrejection", e.reason?.message || String(e.reason)));
  // Quick keyboard toggle: Cmd/Ctrl + Shift + D
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
      debug.toggle();
      console.log("[remie] debug", debug.enabled() ? "ON" : "OFF");
    }
  });
}
