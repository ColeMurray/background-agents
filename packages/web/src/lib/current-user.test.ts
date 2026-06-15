import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { controlPlaneFetch } from "@/lib/control-plane";
import { clearCurrentUserIdCacheForTests, resolveCurrentUserId } from "./current-user";

describe("resolveCurrentUserId — provider-scoped cache", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCurrentUserIdCacheForTests();
  });

  it("does not alias a GitHub id and a numerically identical Google sub", async () => {
    const githubUserId = "0123456789abcdef0123456789abcdef";
    const googleUserId = "fedcba9876543210fedcba9876543210";
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: githubUserId }))
      .mockResolvedValueOnce(Response.json({ userId: googleUserId }));

    // Same numeric id ("123") under two providers must resolve independently.
    const gh = await resolveCurrentUserId({ id: "123", provider: "github", login: "ada" });
    const google = await resolveCurrentUserId({
      id: "123",
      provider: "google",
      email: "pm@gmail.com",
    });

    expect(gh).toEqual({ ok: true, userId: githubUserId });
    expect(google).toEqual({ ok: true, userId: googleUserId });
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      1,
      "/provider-identities/github/123",
      expect.anything()
    );
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/provider-identities/google/123",
      expect.anything()
    );

    // A second GitHub resolution must come from the GitHub-scoped cache entry,
    // not the Google one, and without a third control-plane call.
    const githubAgain = await resolveCurrentUserId({ id: "123", provider: "github", login: "ada" });
    expect(githubAgain).toEqual({ ok: true, userId: githubUserId });
    expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
  });
});
