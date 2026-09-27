import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.pw.ts",
  use: { baseURL: "http://127.0.0.1:5173", browserName: "chromium", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
