import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { modelPreferencesRoutes } from "./model-preferences";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const mockStore = { getEnabledModels: vi.fn(), setEnabledModels: vi.fn() };
vi.mock("../db/model-preferences", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ModelPreferencesStore: vi.fn().mockImplementation(function () {
    return mockStore;
  }),
}));

const handleRequest = createTestRequestHandler([modelPreferencesRoutes]);
const env = {
  ...TEST_SERVICE_SECRETS,
  SCM_PROVIDER: "github",
  DB: ownerAuthorizationDatabase(),
} as unknown as Env;

describe("model preference routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
  });

  it("answers the preference read privately and uncacheably", async () => {
    mockStore.getEnabledModels.mockResolvedValue(null);

    const response = await handleRequest(
      new Request("https://test.local/model-preferences"),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ enabledModels: DEFAULT_ENABLED_MODELS });
  });
});
