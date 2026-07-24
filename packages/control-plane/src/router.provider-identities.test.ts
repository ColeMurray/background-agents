import { describe, expect, it, vi } from "vitest";

import { handleRequest } from "./router";

vi.mock("./auth/web-session-tokens", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    WebSessionTokenService: vi.fn(function () {
      return {
        verifyAccessToken: async (token: string) => ({
          ok: true,
          tokenId: token,
          userId:
            token === "oi_at_google"
              ? "fedcba9876543210fedcba9876543210"
              : "0123456789abcdef0123456789abcdef",
          provider: token === "oi_at_google" ? "google" : "github",
          providerUserId: token === "oi_at_google" ? "google-sub-1" : "12345",
        }),
      };
    }),
  };
});

function createEnv() {
  return {
    SCM_PROVIDER: "gitlab",
    DB: {
      prepare: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
  };
}

function userRequest(path: string, token: string): Request {
  return new Request(`https://test.local${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("provider identity router integration", () => {
  it("resolves a GitHub identity for its matching user when the SCM provider is not github", async () => {
    const response = await handleRequest(
      userRequest("/provider-identities/github/12345", "oi_at_github"),
      createEnv() as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("resolves a Google identity for its matching user when the SCM provider is not github", async () => {
    // Guards the widened isScmAgnosticRoute regex: a typo dropping `google`
    // would make this 501 (SCM not implemented) instead of reaching the handler.
    const response = await handleRequest(
      userRequest("/provider-identities/google/google-sub-1", "oi_at_google"),
      createEnv() as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "fedcba9876543210fedcba9876543210",
    });
  });

  it("rejects non-GitHub provider identity paths when the SCM provider is not github", async () => {
    const response = await handleRequest(
      userRequest("/provider-identities/gitlab/U123", "oi_at_github"),
      createEnv() as never
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "SCM provider 'gitlab' is not implemented in this deployment.",
    });
  });
});
