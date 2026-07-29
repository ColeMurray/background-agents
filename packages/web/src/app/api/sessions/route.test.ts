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
import { GET, POST } from "./route";

function request(path: string) {
  return {
    nextUrl: new URL(`http://localhost${path}`),
  } as NextRequest;
}

function postRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as NextRequest;
}

function controlPlaneBody(callIndex = 0): Record<string, unknown> {
  const options = vi.mocked(controlPlaneUserFetch).mock.calls[callIndex]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("sessions API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await GET(request("/api/sessions?limit=50"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards allowed session query params", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "0123456789abcdef0123456789abcdef" },
    });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(
      request(
        "/api/sessions?debug=true&limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
      )
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions?limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [], hasMore: false });
  });

  it("replaces createdBy=me with the canonical session principal", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    });
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(
      request("/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=me")
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
  });

  it("does not branch on the provider used to authenticate the session", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "fedcba9876543210fedcba9876543210",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
      },
    });
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(request("/api/sessions?limit=50&createdBy=me"));

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions?limit=50&createdBy=fedcba9876543210fedcba9876543210"
    );
    expect(response.status).toBe(200);
  });

  it("resolves createdBy=me alongside explicit creator filters", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    });
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(
      request("/api/sessions?createdBy=ffffffffffffffffffffffffffffffff&createdBy=me&limit=25")
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions?limit=25&createdBy=ffffffffffffffffffffffffffffffff&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
  });

  it("uses the same canonical principal across pagination requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    });
    vi.mocked(controlPlaneUserFetch)
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: true }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: false }, { status: 200 }));

    await GET(request("/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=me"));
    await GET(request("/api/sessions?limit=50&offset=50&excludeStatus=archived&createdBy=me"));

    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(2);
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      1,
      "/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      2,
      "/sessions?limit=50&offset=50&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
  });
});

describe("sessions API route (POST)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r" }));

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("sends display fields without identity or SCM assertions", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ id: "sess1" }, { status: 201 })
    );

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r", model: "m" }));

    expect(response.status).toBe(201);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ method: "POST" })
    );
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      repoOwner: "o",
      repoName: "r",
      model: "m",
      actorEmail: "ada@example.com",
      actorDisplayName: "Ada Lovelace",
      actorAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    // Forbidden under strict identity enforcement: the control plane derives
    // these from the Bearer principal, so the web must not send them.
    expect(sent.userId).toBeUndefined();
    expect(sent.spawnSource).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
    expect(sent.actorUserId).toBeUndefined();
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmRefreshToken).toBeUndefined();
    expect(sent.scmTokenExpiresAt).toBeUndefined();
  });

  it("uses the same display-only body for another sign-in provider", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "fedcba9876543210fedcba9876543210",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
      },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ id: "sess2" }, { status: 201 })
    );

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r", model: "m" }));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      actorEmail: "pm@gmail.com",
      actorDisplayName: "Pat PM",
    });
    expect(sent.userId).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmLogin).toBeUndefined();
    expect(sent.scmEmail).toBeUndefined();
  });

  it("forwards environmentId for environment launches", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "0123456789abcdef0123456789abcdef" },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ id: "sess3" }, { status: 201 })
    );

    const response = await POST(postRequest({ environmentId: "env-1", model: "m" }));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent.environmentId).toBe("env-1");
    expect(sent.repositories).toBeUndefined();
    expect(sent.repoOwner).toBeUndefined();
    expect(sent.repoName).toBeUndefined();
  });

  it("forwards the repositories list for ad-hoc multi-repo launches", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "0123456789abcdef0123456789abcdef" },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ id: "sess4" }, { status: 201 })
    );

    const repositories = [
      { repoOwner: "acme", repoName: "backend" },
      { repoOwner: "acme", repoName: "frontend" },
    ];
    const response = await POST(postRequest({ repositories, model: "m" }));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent.repositories).toEqual(repositories);
    expect(sent.environmentId).toBeUndefined();
  });

  it("still strips fields outside the allowlist", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "0123456789abcdef0123456789abcdef" },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ id: "sess5" }, { status: 201 })
    );

    const response = await POST(
      postRequest({
        environmentId: "env-1",
        userId: "attacker",
        spawnSource: "automation",
        scmToken: "gho_forged",
        authUserId: "someone-else",
      })
    );

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent.environmentId).toBe("env-1");
    // Client-asserted identity never reaches the control plane — under strict
    // enforcement the body carries no identity fields at all.
    expect(sent.userId).toBeUndefined();
    expect(sent.spawnSource).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
  });
});
