import { defineConfig } from "vitest/config";

// The authenticated preview's contracts, run by the root `npm run test:preview` with its browser
// suite. They start real servers and include the idle/resume regression, which takes about half a
// minute, so they stay out of the unit lane.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/preview/**/*.test.ts", "test/support/**/*.test.ts"],
  },
});
