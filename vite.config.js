// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/messaging": {
        target: "http://localhost:54321/functions/v1/messaging",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/messaging/, ""),
      },
      "/api/telephony": {
        target: "http://localhost:54321/functions/v1/telephony",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/telephony/, ""),
      },
    },
  },
});
