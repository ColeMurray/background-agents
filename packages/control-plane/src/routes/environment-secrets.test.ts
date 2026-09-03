import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { generateEncryptionKey } from "../auth/crypto";
import type { SqlDatabase } from "../db/sql-database";
import { environmentSecretsRoutes } from "./environment-secrets";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([environmentSecretsRoutes]);

/** Admission's role lookup is answered for the owner; every other statement reaches the test's database. */
function withOwnerAuthorization(delegate: SqlDatabase): SqlDatabase {
  const authorization = ownerAuthorizationDatabase();
  return {
    prepare: (sql) => (sql.includes("FROM users u") ? authorization : delegate).prepare(sql),
    batch: (statements) => delegate.batch(statements),
  };
}

function createEnv(encryptionKey: string) {
  const batch = vi.fn(async () => []);
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
  const db = { batch, prepare: vi.fn(() => ({ bind })) } as unknown as SqlDatabase;
  return {
    env: {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      REPO_SECRETS_ENCRYPTION_KEY: encryptionKey,
      DB: withOwnerAuthorization(db),
    } as unknown as Env,
    batch,
  };
}

function putSecrets(env: Env, body: string): Promise<Response> {
  return handleRequest(
    new Request("https://test.local/environments/env-1/secrets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("environment secrets routes", () => {
  beforeEach(() => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
  });

  it("rejects malformed secret values before persistence", async () => {
    const { env, batch } = createEnv("test-key");

    const response = await putSecrets(env, JSON.stringify({ secrets: { API_KEY: 123 } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must include secrets object",
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects array-shaped secrets before persistence", async () => {
    const { env, batch } = createEnv("test-key");

    const response = await putSecrets(env, JSON.stringify({ secrets: [] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body must include secrets object",
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("preserves an own __proto__ secret key for canonical normalization", async () => {
    const { env, batch } = createEnv(generateEncryptionKey());

    const response = await putSecrets(env, '{"secrets":{"__proto__":"value"}}');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ keys: ["__PROTO__"], created: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("accepts valid secret records", async () => {
    const { env, batch } = createEnv(generateEncryptionKey());

    const response = await putSecrets(env, JSON.stringify({ secrets: { API_KEY: "secret" } }));

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
