import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/static": "http://127.0.0.1:8080",
      "/slackdump/file": "http://127.0.0.1:8080",
      "^/archives/[^/]+/canvas/content$": "http://127.0.0.1:8080",
    },
  },
  build: { outDir: "../internal/viewer/web", emptyOutDir: true },
});
