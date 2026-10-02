import { defineConfig } from "vitest/config";
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
      exclude: ["src/**/*.test.ts", "src/**/*.test-support.ts", "src/**/*.d.ts", "src/index.ts"],
      thresholds: { statements: 89.47, branches: 81.84, functions: 93.79, lines: 91.12 },
    },
  },
});
