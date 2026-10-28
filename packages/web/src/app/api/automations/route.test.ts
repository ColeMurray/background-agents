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
    cookies: { getAll: () => [{ name: "openinspect.session_token", value: "test-session" }] },
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
  harness: "claude",
};

const providerSelections = {
  openai: { mode: "provider_account", accountId: "a".repeat(32) },
  xai: { mode: "api_key" },
};

describe("automations API route (GET)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("forwards only automation list parameters", async () => {
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
        teamId: "team/one",
        offset: "50",
      })
    );

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations?search=daily+sync&limit=25&cursor=123%3Aauto-1&repoOwner=acme&repoName=web-app&teamId=team%2Fone"
    );
  });
});

describe("automations API route (POST)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(["team-1", null])("forwards create teamId=%s", async (teamId) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ automation: {} }));
    await POST(postRequest({ ...validBody, teamId }));
    expect(controlPlaneBody()).toEqual({ ...validBody, teamId });
  });

  it("forwards a one-shot timestamp without adding cron", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: {} }, { status: 201 })
    );
    const { scheduleCron: _cron, ...oneShot } = validBody;
    const body = { ...oneShot, scheduleOnceAt: Date.now() + 60_000 };
    expect((await POST(postRequest(body))).status).toBe(201);
    expect(controlPlaneBody()).toEqual(body);
  });

  it("relays a control-plane 401 without a separate session lookup", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });

  it("sends a profile-independent body without resolving the user session", async () => {
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
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });

  it("drops non-allowlisted fields (including client-asserted identity) from the forwarded body", async () => {
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

  it("forwards the launch retry limit", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto-retries" } }, { status: 201 })
    );

    await POST(postRequest({ ...validBody, maxRetries: 3 }));

    expect(controlPlaneBody()).toEqual({ ...validBody, maxRetries: 3 });
  });

  it("allowlists provider selections while dropping hydrated provider auth", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto-provider" } }, { status: 201 })
    );

    await POST(
      postRequest({ ...validBody, providerSelections, providerAuth: [{ refreshToken: "secret" }] })
    );

    expect(controlPlaneBody()).toEqual({ ...validBody, providerSelections });
  });
});
