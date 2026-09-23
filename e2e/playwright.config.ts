import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../test-results/preview",
  use: { browserName: "chromium", screenshot: "only-on-failure", trace: "off", video: "off" },
});
