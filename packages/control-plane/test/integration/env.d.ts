import type { WorkerBindings } from "../../src/cloudflare/platform";
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // The pool types `env` from "cloudflare:test" as `Cloudflare.Env`, an
    // extensible placeholder in @cloudflare/workers-types. Merge in the
    // worker's real bindings plus the test-only migration list injected by
    // vitest.integration.config.ts. Keep the shape identical to the
    // Worker's bindings (no narrowing): tests pass `env` straight into
    // worker entrypoints typed against it, and build the application `Env`
    // with `createCloudflareEnv` where they call past the entrypoint.
    // Session-DO stubs get their type at the `runInSessionDO` seam in
    // session-do-access.ts instead.
    interface Env extends WorkerBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
