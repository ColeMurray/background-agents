import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const mockProfileStore = { list: vi.fn() };
vi.mock("../db/skill-profiles", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SkillProfileStore: vi.fn().mockImplementation(function () {
    return mockProfileStore;
  }),
}));

const handleRequest = createTestRequestHandler([skillRoutes]);
const env = { ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() } as unknown as Env;

describe("skill profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
  });

  it("answers the caller's own profiles privately and uncacheably", async () => {
    mockProfileStore.list.mockResolvedValue([]);

    const response = await handleRequest(
      new Request("https://test.local/skill-profiles"),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ profiles: [] });
    expect(mockProfileStore.list).toHaveBeenCalledWith("user-1");
  });
});
