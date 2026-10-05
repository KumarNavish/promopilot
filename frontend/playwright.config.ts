import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true
  },
  webServer: [
    {
      command: "python3 -m app.ml.train --rows 20000 && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000",
      cwd: "../backend",
      port: 8000,
      timeout: 120_000,
      reuseExistingServer: true
    },
    {
      command: "npm run preview",
      cwd: ".",
      port: 4173,
      timeout: 120_000,
      reuseExistingServer: true
    }
  ]
});
