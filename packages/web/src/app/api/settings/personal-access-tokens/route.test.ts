import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";
import { DELETE as revokeToken } from "./[id]/route";
import { DELETE as revokeMemberTokens } from "../../members/[userId]/personal-access-tokens/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("workspace personal access token relays", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists every member's tokens privately, passing the page through", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ tokens: [], nextCursor: null })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/settings/personal-access-tokens?limit=1&cursor=1%3Aab"),
      { params: Promise.resolve({}) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/settings/personal-access-tokens?limit=1&cursor=1%3Aab",
      undefined,
      { timeoutMs: undefined }
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("revokes a token by an encoded id", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ revoked: true }));

    await revokeToken(
      new NextRequest("http://localhost/api/settings/personal-access-tokens/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "../policy" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/settings/personal-access-tokens/..%2Fpolicy",
      { method: "DELETE" },
      { timeoutMs: undefined }
    );
  });

  it("revokes all of a member's tokens by an encoded user id", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ revoked: 2 }));

    await revokeMemberTokens(
      new NextRequest("http://localhost/api/members/x/personal-access-tokens", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ userId: "../roles" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/members/..%2Froles/personal-access-tokens",
      { method: "DELETE" },
      { timeoutMs: undefined }
    );
  });
});
