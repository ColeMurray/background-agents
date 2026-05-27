import { afterEach, describe, expect, it, vi } from "vitest";
import { getVerifiedPrimaryGitHubEmail } from "./auth";

describe("getVerifiedPrimaryGitHubEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the verified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "other@example.com", primary: false, verified: true, visibility: "private" },
          { email: "user@company.com", primary: true, verified: true, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBe("user@company.com");
  });

  it("rejects an unverified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "user@company.com", primary: true, verified: false, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });

  it("returns null when GitHub email lookup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });
});
