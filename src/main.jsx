// File: src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// ---- PWA Service Worker registration + update flow ----
if ("serviceWorker" in navigator) {
  // Bump this string anytime you ship changes that must force-refresh the PWA.
  const SW_VERSION = "v3";

  // When a new SW takes control, reload to get fresh JS/CSS.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Avoid infinite loops: only reload once per takeover.
    if (!window.__reloadedForSW) {
      window.__reloadedForSW = true;
      window.location.reload();
    }
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${SW_VERSION}`)
      .then((reg) => {
        // If an updated SW is found, make it activate ASAP
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            // When it's installed and there's already a controller,
            // it means an update is ready.
            if (
              newWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // Ask the waiting SW to skip waiting (our sw.js listens for this).
              if (reg.waiting) {
                reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            }
          });
        });
      })
      .catch((err) => {
        // Non-fatal; just log it
        console.warn("[sw] register failed:", err?.message || err);
      });
  });
}