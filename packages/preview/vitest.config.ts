import { defineConfig } from "vitest/config";

// Contract tests start real servers (the Node host, fake Modal, stand-in Next processes), so they
// run in this package's own lane rather than beside the control plane's unit tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
