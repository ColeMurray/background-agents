import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { createCloudflareEnv, type WorkerBindings } from "../../src/cloudflare/platform";
import type { Env } from "../../src/types";
import { createSessionRuntime } from "../../src/session/components";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import { componentsOf, runInSessionDO } from "./session-do-access";

/**
 * The composition root is fail-fast: both provider factories construct at
 * graph build, so a misconfigured deployment fails every session request at
 * initialization — before any session state is written — instead of running
 * degraded and surfacing the error at the first spawn or PR operation.
 */
describe("createSessionRuntime", () => {
  async function buildWithEnv(overrides: Partial<Record<keyof Env, string | undefined>>) {
    const stub = env.SESSION.get(env.SESSION.idFromName(`components-eager-${crypto.randomUUID()}`));

    return runInSessionDO(stub, (instance: SessionDO, state) => {
      // Apply the schema first (idempotent init), matching production order.
      componentsOf(instance);

      const doctored = createCloudflareEnv({
        ...(instance as unknown as { env: WorkerBindings }).env,
        ...overrides,
      } as WorkerBindings);

      let error: string | null = null;
      try {
        createSessionRuntime(createDurableObjectSessionPlatform(state, env.DB), doctored);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return error;
    });
  }

  it("builds the whole graph on a correctly configured deployment", async () => {
    expect(await buildWithEnv({})).toBeNull();
  });

  it("fails at graph build on an unsupported SANDBOX_PROVIDER", async () => {
    const error = await buildWithEnv({ SANDBOX_PROVIDER: "not-a-real-sandbox-provider" });
    expect(error).toMatch(/SANDBOX_PROVIDER/);
  });

  it("fails at graph build when the selected sandbox provider's credentials are missing", async () => {
    const error = await buildWithEnv({
      SANDBOX_PROVIDER: "modal",
      MODAL_API_SECRET: undefined,
      MODAL_WORKSPACE: undefined,
    });
    expect(error).toMatch(/MODAL_API_SECRET/);
  });

  it("fails at graph build on an invalid SCM_PROVIDER", async () => {
    const error = await buildWithEnv({ SCM_PROVIDER: "not-a-real-provider" });
    expect(error).toMatch(/SCM_PROVIDER/i);
  });
});
