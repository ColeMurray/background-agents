import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpencodePluginStoreModule from "../db/opencode-plugins";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Env } from "../types";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { opencodePluginRoutes } from "./opencode-plugins";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
vi.mock("../db/opencode-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof OpencodePluginStoreModule>()),
  OpencodePluginStore: vi.fn().mockImplementation(function () {
    return { list: mocks.list, create: mocks.create, update: mocks.update, delete: mocks.remove };
  }),
}));
const handleRequest = createTestRequestHandler([opencodePluginRoutes]);
const plugin = { id: "1", spec: "audit@1.0.0", repoScopes: null, enabled: true };

describe("SCM-agnostic plugin admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mocks.list.mockResolvedValue([plugin]);
    mocks.create.mockResolvedValue(plugin);
    mocks.update.mockResolvedValue(plugin);
    mocks.remove.mockResolvedValue(true);
  });
  it.each(["GET", "POST", "PUT", "DELETE"])("admits %s with GitLab", async (method) => {
    const path =
      method === "PUT" || method === "DELETE" ? "/opencode-plugins/1" : "/opencode-plugins";
    const response = await handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        ...(["POST", "PUT"].includes(method)
          ? { body: JSON.stringify(method === "PUT" ? { enabled: false } : { spec: plugin.spec }) }
          : {}),
      }),
      { ...TEST_SERVICE_SECRETS, SCM_PROVIDER: "gitlab", DB: ownerAuthorizationDatabase() } as Env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(method === "POST" ? 201 : 200);
  });
});
