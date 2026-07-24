import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";

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
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/provider-identities/github/12345", {
        method: "PUT",
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

  it("serves Google provider identity upserts even when the SCM provider is not github", async () => {
    // Guards the widened isScmAgnosticRoute regex: a typo dropping `google`
    // would make this 501 (SCM not implemented) instead of reaching the handler.
    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/provider-identities/google/google-sub-1", {
        method: "PUT",
        body: JSON.stringify({
          providerEmail: "pm@corp.com",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
    expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", providerUserId: "google-sub-1" })
    );
  });

  it("rejects non-GitHub provider identity paths when the SCM provider is not github", async () => {
    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/provider-identities/gitlab/U123", {
        method: "PUT",
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
