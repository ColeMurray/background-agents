import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as ScmSettingsModule from "../db/scm-settings";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import {
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { scmSettingsRoutes } from "./scm-settings";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  store: {
    getGlobal: vi.fn(),
    setGlobal: vi.fn(),
    deleteGlobal: vi.fn(),
    listRepoSettings: vi.fn(),
    setRepoSettings: vi.fn(),
    deleteRepoSettings: vi.fn(),
  },
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/scm-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof ScmSettingsModule>()),
  ScmSettingsStore: vi.fn().mockImplementation(function () {
    return mocks.store;
  }),
}));

const handleRequest = createTestRequestHandler([scmSettingsRoutes]);
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Answers admission's owner lookup; the settings store is mocked, so nothing else reads D1. */
function ownerDatabase(): SqlDatabase {
  return {
    prepare(sql: string) {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() =>
          (sql.includes("FROM users u")
            ? {
                user_id: "user-1",
                suspended_at: null,
                role_id: BUILT_IN_ROLE_REGISTRY.owner.id,
                role_key: "owner",
                role_name: "Owner",
              }
            : null) as T | null,
        all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

const env = {
  ...TEST_SERVICE_SECRETS,
  SCM_PROVIDER: "github",
  DB: ownerDatabase(),
} as unknown as Env;

function callRoute(method: string, path: string, body?: unknown): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("SCM settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    for (const method of Object.values(mocks.store)) {
      method.mockRejectedValue(new Error("D1 unavailable"));
    }
  });

  it.each([
    ["GET", "/scm-settings", undefined, "getGlobal", []],
    ["PUT", "/scm-settings", { settings: {} }, "setGlobal", [{}]],
    ["DELETE", "/scm-settings", undefined, "deleteGlobal", []],
    ["GET", "/scm-settings/repos", undefined, "listRepoSettings", []],
    [
      "PUT",
      "/scm-settings/repos/acme/web",
      { settings: { alwaysUseDraftMode: true } },
      "setRepoSettings",
      ["acme/web", { alwaysUseDraftMode: true }],
    ],
    ["DELETE", "/scm-settings/repos/acme/web", undefined, "deleteRepoSettings", ["acme/web"]],
  ] as const)("routes %s %s to the store", async (method, path, body, storeMethod, args) => {
    const target = mocks.store[storeMethod];
    target.mockResolvedValue(storeMethod === "listRepoSettings" ? [] : null);

    const response = await callRoute(method, path, body);

    expect(response.status).toBe(200);
    expect(target).toHaveBeenCalledWith(...args);
    for (const [name, other] of Object.entries(mocks.store)) {
      if (name !== storeMethod) expect(other).not.toHaveBeenCalled();
    }
  });

  it.each(["/scm-settings", "/scm-settings/repos"])(
    "maps storage read failures for GET %s to 503",
    async (path) => {
      const response = await callRoute("GET", path);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "SCM settings storage unavailable",
      });
    }
  );

  it.each([
    ["PUT", "/scm-settings", { settings: { enabledRepos: ["acme/web"] } }, "Unrecognized key"],
    [
      "PUT",
      "/scm-settings/repos/acme/web",
      { settings: { alwaysUseDraftMode: "yes" } },
      "alwaysUseDraftMode must be a boolean",
    ],
  ])("rejects malformed settings for %s %s before storage", async (method, path, body, message) => {
    const response = await callRoute(method, path, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(message),
    });
    expect(mocks.store.setGlobal).not.toHaveBeenCalled();
    expect(mocks.store.setRepoSettings).not.toHaveBeenCalled();
  });

  it("reads the repository from the segments Hono decoded, without decoding again", async () => {
    mocks.store.deleteRepoSettings.mockResolvedValue(undefined);

    // One decode turns `%2F` into a slash the name may not hold.
    const slashInName = await callRoute("DELETE", "/scm-settings/repos/acme/web%2Fapp");
    expect(slashInName.status).toBe(400);
    await expect(slashInName.json()).resolves.toEqual({
      error: "Owner and name must be valid repository path segments",
    });
    expect(mocks.store.deleteRepoSettings).not.toHaveBeenCalled();

    // A doubly-encoded slash survives the single decode as a literal `%2F`.
    const doubleEncoded = await callRoute("DELETE", "/scm-settings/repos/acme/web%252Fapp");
    expect(doubleEncoded.status).toBe(200);
    expect(mocks.store.deleteRepoSettings).toHaveBeenCalledWith("acme/web%2Fapp");
  });
});
