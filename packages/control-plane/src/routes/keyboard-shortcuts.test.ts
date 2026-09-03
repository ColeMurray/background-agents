import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { keyboardShortcutRoutes } from "./keyboard-shortcuts";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const mockStore = { get: vi.fn(), set: vi.fn() };
vi.mock("../db/keyboard-shortcut-preferences", () => ({
  KeyboardShortcutPreferencesStore: vi.fn().mockImplementation(function () {
    return mockStore;
  }),
}));

const handleRequest = createTestRequestHandler([keyboardShortcutRoutes]);
const env = { ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() } as unknown as Env;

describe("keyboard shortcut routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
  });

  it("answers a personal read privately and uncacheably", async () => {
    mockStore.get.mockResolvedValue({ "session.new": "mod+k" });

    const response = await handleRequest(
      new Request("https://test.local/keyboard-shortcuts"),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ shortcuts: { "session.new": "mod+k" } });
    expect(mockStore.get).toHaveBeenCalledWith("user-1");
  });

  it("declares no cache policy on the write", async () => {
    mockStore.set.mockResolvedValue(DEFAULT_KEYBOARD_SHORTCUTS);

    const response = await handleRequest(
      new Request("https://test.local/keyboard-shortcuts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS }),
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});
