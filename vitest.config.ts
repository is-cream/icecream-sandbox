import { defineConfig } from "vitest/config";

// Unit tests and the security suite's unit half. Browser tests live in
// test/browser and run under Playwright (npm run test:browser); they must
// never be picked up here.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/security/**/*.test.ts"],
  },
});
