export default {
  server: {
    proxy: {
      "/api/telephony": {
        target: "http://localhost:54321/functions/v1/telephony",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/telephony/, ""),
      },
      "/api/messaging": {
        target: "http://localhost:54321/functions/v1/messaging",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/messaging/, ""),
      },
    },
  },
};
