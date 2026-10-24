import { createExecutionContext, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createCloudflareBackgroundTasks } from "../../src/cloudflare/background-tasks";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { createRequestContext } from "../../src/http/create-request-context";

it("reuses the auth runtime across request contexts while isolating query metrics", async () => {
  const context = () => {
    const appEnv = createCloudflareEnv({ ...env });
    return createRequestContext({
      request: new Request("https://test.local/api/auth/get-session"),
      env: appEnv,
      database: appEnv.DB,
      executionCtx: createCloudflareBackgroundTasks(createExecutionContext()),
    });
  };
  const first = context();
  const second = context();
  const firstRuntime = first.getUserAuthRuntime?.();
  const secondRuntime = second.getUserAuthRuntime?.();
  expect(firstRuntime).toBeDefined();
  expect(firstRuntime === secondRuntime).toBe(true);
  expect(first.db).not.toBe(second.db);
  expect(first.metrics).not.toBe(second.metrics);
  await first.db.prepare("SELECT 1").first();
  expect(first.metrics.sqlQueries).toHaveLength(1);
  expect(second.metrics.sqlQueries).toHaveLength(0);
});
