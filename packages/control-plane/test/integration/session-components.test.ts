import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import type { Env } from "../../src/types";
import { createSessionRuntime } from "../../src/session/components";
import { componentsOf } from "./session-do-access";

describe("createSessionRuntime", () => {
  it("builds the whole graph eagerly without constructing either provider", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`components-eager-${crypto.randomUUID()}`));

    const result = await runInDurableObject(stub, (instance: SessionDO) => {
      // Apply the schema (idempotent init) — the factory reads the session row.
      componentsOf(instance);

      // A deployment shape that works today only because both provider
      // factories are deferred: no sandbox credentials, no valid SCM provider.
      const misconfigured = {
        ...(instance as unknown as { env: Env }).env,
        SANDBOX_PROVIDER: "not-a-real-sandbox-provider",
        MODAL_API_SECRET: undefined,
        MODAL_WORKSPACE: undefined,
        SCM_PROVIDER: "not-a-real-provider",
      } as Env;

      // Eager construction of either provider would throw right here and fail
      // every request on such a deployment; the graph must still assemble.
      const runtime = createSessionRuntime(
        {
          ctx: instance.ctx,
          sql: instance.ctx.storage.sql,
          db: null,
          ensureInitialized: () => {},
        },
        misconfigured
      );
      const components = runtime.internals;

      let scmError: string | null = null;
      try {
        components.sourceControlProvider();
      } catch (error) {
        scmError = error instanceof Error ? error.message : String(error);
      }

      return {
        built: Boolean(
          runtime.server &&
          components.lifecycleManager &&
          components.messageQueue &&
          components.sessionLifecycleHandler &&
          components.sandboxEventProcessor
        ),
        scmError,
      };
    });

    expect(result.built).toBe(true);
    // The deferred SCM factory still surfaces its configuration error at the
    // first operation that needs it.
    expect(result.scmError).toMatch(/SCM_PROVIDER/i);
  });
});
