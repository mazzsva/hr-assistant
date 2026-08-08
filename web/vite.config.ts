import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ask": "http://localhost:3000",
      "/meta": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
});
