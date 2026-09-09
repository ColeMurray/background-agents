import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_LIST_PAGE_SIZE } from "@open-inspect/shared/types/skills";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mockStore = { list: vi.fn() };
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/skills", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SkillStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

const handleRequest = createTestRequestHandler([skillRoutes]);
const env = { ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() } as unknown as Env;

function list(query = ""): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local/skills${query}`),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("GET /skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mockStore.list.mockResolvedValue({ skills: [], nextCursor: null });
  });

  it("lists the first full page when the query names none", async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(mockStore.list).toHaveBeenCalledWith({ limit: SKILL_LIST_PAGE_SIZE, cursor: null });
  });

  it("passes a page size and a skill-name cursor to the store", async () => {
    const response = await list("?limit=25&cursor=my-skill");

    expect(response.status).toBe(200);
    expect(mockStore.list).toHaveBeenCalledWith({ limit: 25, cursor: "my-skill" });
  });

  it.each([
    ["?limit=0", "Invalid limit"],
    ["?limit=abc", "Invalid limit"],
    [`?limit=${SKILL_LIST_PAGE_SIZE + 1}`, "Invalid limit"],
    ["?limit=1&limit=2", "Invalid limit"],
    ["?cursor=Not%20A%20Skill%20Name", "Invalid cursor"],
    ["?cursor=a&cursor=b", "Invalid cursor"],
  ])("rejects %s without listing", async (query, error) => {
    const response = await list(query);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mockStore.list).not.toHaveBeenCalled();
  });
});
