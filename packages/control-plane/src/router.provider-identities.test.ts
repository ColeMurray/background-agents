import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const mockUserStore = {
  resolveOrCreateUser: vi.fn(),
};

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

describe("provider identity router integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserStore.resolveOrCreateUser.mockResolvedValue({
      id: "0123456789abcdef0123456789abcdef",
      displayName: "Ada",
      email: "ada@example.com",
      isNew: false,
    });
  });

  it("serves provider identity upserts even when the SCM provider is not github", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/provider-identities/github/12345", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          providerLogin: "ada",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("rejects non-GitHub provider identity paths when the SCM provider is not github", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/provider-identities/gitlab/U123", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }),
      env as never
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "SCM provider 'gitlab' is not implemented in this deployment.",
    });
    expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
  });
});
