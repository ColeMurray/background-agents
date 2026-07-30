import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { hostileIdentityFields } from "../hostile-identity.test-fixture";
import { GET, POST } from "./route";

function postRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as NextRequest;
}

function getRequest(searchParams: Record<string, string>) {
  return {
    nextUrl: { searchParams: new URLSearchParams(searchParams) },
  } as unknown as NextRequest;
}

function controlPlaneBody(callIndex = 0): Record<string, unknown> {
  const options = vi.mocked(controlPlaneUserFetch).mock.calls[callIndex]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

const validBody = {
  name: "Daily sync",
  repositories: [{ repoOwner: "o", repoName: "r" }],
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  instructions: "Run tests",
};

describe("automations API route (GET)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("forwards only automation list parameters", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automations: [], hasMore: false, nextCursor: null })
    );

    const response = await GET(
      getRequest({
        search: "daily sync",
        limit: "25",
        cursor: "123:auto-1",
        repoOwner: "acme",
        repoName: "web-app",
        offset: "50",
      })
    );

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations?search=daily+sync&limit=25&cursor=123%3Aauto-1&repoOwner=acme&repoName=web-app"
    );
  });
});

describe("automations API route (POST)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "GitHub",
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    },
    {
      provider: "Google",
      user: {
        id: "fedcba9876543210fedcba9876543210",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
      },
    },
  ])("sends the same profile-independent body for a $provider session", async ({ user }) => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto1" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ method: "POST" })
    );
    const sent = controlPlaneBody();
    expect(sent).toEqual(validBody);
  });

  it("drops non-allowlisted fields (including client-asserted identity) from the forwarded body", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "0123456789abcdef0123456789abcdef" },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto3" } }, { status: 201 })
    );

    const response = await POST(
      postRequest({
        ...validBody,
        ...hostileIdentityFields,
      })
    );

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toEqual(validBody);
  });
});
