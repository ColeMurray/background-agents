import path from "path";
import { defineConfig } from "vitest/config";
import { coverageExclusions, coverageThresholds } from "../../scripts/coverage-policy";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: coverageExclusions("web"),
      // Shards cannot meet a full-suite threshold; enforce it after merging their reports.
      thresholds: process.env.COVERAGE_SHARD === "true" ? undefined : coverageThresholds("web"),
    },
  },
});
