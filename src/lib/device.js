// File: src/lib/device.js
export function detectDevice() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh/i.test(ua)) return "mac";
  if (/Android/i.test(ua) || /iPhone|iPad|iPod/i.test(ua)) return "mobile";
  return "unknown";
}
