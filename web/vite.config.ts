import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies to the API. Set API_URL when it is not on port 3000.
const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ask": api,
      "/meta": api,
      "/healthz": api,
      "/stats": api,
    },
  },
});
