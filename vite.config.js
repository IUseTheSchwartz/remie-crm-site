// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // local dev server port
  },
  build: {
    outDir: "dist", // Netlify expects build output here
    sourcemap: false, // optional: disable if not debugging
  },
});
