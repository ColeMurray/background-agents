import { defineConfig } from "vitest/config";
import { coverageExclusions, coverageThresholds } from "../../scripts/coverage-policy";
import integrationConfig from "./vitest.integration.config";

export default defineConfig({
  // These worker options apply at the Vitest root, not within individual projects.
  resolve: integrationConfig.resolve,
  test: {
    onUnhandledError: integrationConfig.test?.onUnhandledError,
    projects: [
      { extends: "./vitest.config.ts", test: { name: "unit" } },
      { extends: "./vitest.integration.config.ts", test: { name: "integration" } },
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: coverageExclusions("control-plane"),
      thresholds: coverageThresholds("control-plane"),
    },
  },
});
