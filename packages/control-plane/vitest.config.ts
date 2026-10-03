import { defineConfig } from "vitest/config";
import { coverageExclusions } from "../../scripts/coverage-policy";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/conformance/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: coverageExclusions("control-plane"),
    },
  },
});
