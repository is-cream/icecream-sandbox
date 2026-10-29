import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  webServer: [
    {
      command: "node demo/demo-server.mjs 8901",
      port: 8901,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "node test/browser/canary-server.mjs 8902",
      port: 8902,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
