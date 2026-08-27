import { describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "../auth/crypto";
import { environmentSecretsRoutes } from "./environment-secrets";
import type { RequestContext, Route } from "./shared";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

function findRoute(method: string, path: string): { route: Route; match: RegExpMatchArray } {
  const route = environmentSecretsRoutes.find(
    (candidate) => candidate.method === method && path.match(candidate.pattern)
  );
  if (!route) throw new Error(`Missing ${method} ${path} route`);
  return { route, match: path.match(route.pattern)! };
}

function createContext() {
  const batch = vi.fn(async () => undefined);
  const run = vi.fn(async () => ({ meta: { changes: 0 } }));
  const all = vi.fn(async () => ({ results: [] }));
  const first = vi.fn(async () => ({
    id: "env-1",
    name: "Production",
    description: null,
    prebuild_enabled: 0,
    channel_associations: null,
    created_at: 1,
    updated_at: 1,
  }));
  const bind = vi.fn(() => ({ first, all, run }));
  return {
    ctx: {
      request_id: "request-1",
      trace_id: "trace-1",
      executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
      db: {
        batch,
        prepare: vi.fn(() => ({ bind })),
      },
    } as unknown as RequestContext,
    batch,
  };
}

describe("environment secrets routes", () => {
  it("rejects malformed secret values before persistence", async () => {
    const { route, match } = findRoute("PUT", "/environments/env-1/secrets");
    const { ctx, batch } = createContext();

    const response = await route.handler(
      new Request("https://test.local/environments/env-1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { API_KEY: 123 } }),
      }),
      { REPO_SECRETS_ENCRYPTION_KEY: "test-key" } as never,
      match,
      ctx
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must include secrets object",
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects array-shaped secrets before persistence", async () => {
    const { route, match } = findRoute("PUT", "/environments/env-1/secrets");
    const { ctx, batch } = createContext();

    const response = await route.handler(
      new Request("https://test.local/environments/env-1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [] }),
      }),
      { REPO_SECRETS_ENCRYPTION_KEY: "test-key" } as never,
      match,
      ctx
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must include secrets object",
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("preserves an own __proto__ secret key for canonical normalization", async () => {
    const { route, match } = findRoute("PUT", "/environments/env-1/secrets");
    const { ctx, batch } = createContext();

    const response = await route.handler(
      new Request("https://test.local/environments/env-1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: '{"secrets":{"__proto__":"value"}}',
      }),
      { REPO_SECRETS_ENCRYPTION_KEY: generateEncryptionKey() } as never,
      match,
      ctx
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ keys: ["__PROTO__"], created: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("accepts valid secret records", async () => {
    const { route, match } = findRoute("PUT", "/environments/env-1/secrets");
    const { ctx, batch } = createContext();

    const response = await route.handler(
      new Request("https://test.local/environments/env-1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { API_KEY: "secret" } }),
      }),
      { REPO_SECRETS_ENCRYPTION_KEY: generateEncryptionKey() } as never,
      match,
      ctx
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "updated",
      environmentId: "env-1",
      keys: ["API_KEY"],
      created: 1,
      updated: 0,
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
