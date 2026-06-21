import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { controlPlaneFetch } from "@/lib/control-plane";
import { clearCurrentUserIdCacheForTests } from "@/lib/current-user";
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
  const options = vi.mocked(controlPlaneFetch).mock.calls[callIndex]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("sessions API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCurrentUserIdCacheForTests();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(request("/api/sessions?limit=50"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards allowed session query params", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(
      request(
        "/api/sessions?debug=true&limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
      )
    );

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/sessions?limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [], hasMore: false });
  });

  it("resolves createdBy=me before forwarding sessions to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: "0123456789abcdef0123456789abcdef" }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: false }, { status: 200 }));

    const response = await GET(
      request("/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=me")
    );

    expect(controlPlaneFetch).toHaveBeenNthCalledWith(1, "/provider-identities/github/12345", {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      }),
    });
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
  });

  it("returns 409 when createdBy=me cannot resolve a user id", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: "ada@example.com" } } as never);

    const response = await GET(request("/api/sessions?createdBy=me"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "User id unavailable" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("resolves createdBy=me for a Google user via the google provider route", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "google-sub-1",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
        provider: "google",
      },
    } as never);
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: "0123456789abcdef0123456789abcdef" }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: false }, { status: 200 }));

    const response = await GET(request("/api/sessions?limit=50&createdBy=me"));

    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      1,
      "/provider-identities/google/google-sub-1",
      {
        method: "PUT",
        body: JSON.stringify({
          providerLogin: undefined,
          providerEmail: "pm@gmail.com",
          displayName: "Pat PM",
          avatarUrl: "https://lh3.googleusercontent.com/a/pat",
        }),
      }
    );
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/sessions?limit=50&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
  });

  it("resolves createdBy=me alongside explicit creator filters", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: "0123456789abcdef0123456789abcdef" }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: false }, { status: 200 }));

    const response = await GET(
      request("/api/sessions?createdBy=ffffffffffffffffffffffffffffffff&createdBy=me&limit=25")
    );

    expect(controlPlaneFetch).toHaveBeenNthCalledWith(1, "/provider-identities/github/12345", {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      }),
    });
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/sessions?limit=25&createdBy=ffffffffffffffffffffffffffffffff&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
  });

  it("reuses the resolved current user across createdBy=me pagination requests", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: "0123456789abcdef0123456789abcdef" }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: true }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ sessions: [], hasMore: false }, { status: 200 }));

    await GET(request("/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=me"));
    await GET(request("/api/sessions?limit=50&offset=50&excludeStatus=archived&createdBy=me"));

    expect(controlPlaneFetch).toHaveBeenCalledTimes(3);
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(1, "/provider-identities/github/12345", {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      }),
    });
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      3,
      "/sessions?limit=50&offset=50&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
  });
});

describe("sessions API route (POST)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r" }));

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("sends auth* and scm* for a GitHub session", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
        provider: "github",
      },
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      accessToken: "gho_abc",
      refreshToken: "ghr_def",
      accessTokenExpiresAt: 1_700_000_000_000,
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ id: "sess1" }, { status: 201 }));

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r", model: "m" }));

    expect(response.status).toBe(201);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneBody()).toMatchObject({
      repoOwner: "o",
      repoName: "r",
      model: "m",
      spawnSource: "user",
      userId: "12345",
      authProvider: "github",
      authUserId: "12345",
      authEmail: "ada@example.com",
      authName: "Ada Lovelace",
      authAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
      scmUserId: "12345",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
      scmEmail: "ada@example.com",
      scmAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
      scmToken: "gho_abc",
      scmRefreshToken: "ghr_def",
      scmTokenExpiresAt: 1_700_000_000_000,
    });
  });

  it("sends auth* but no scm* for a Google session (no token leak)", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "google-sub-1",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
        provider: "google",
      },
    } as never);
    // A token on the JWT must not bleed into scm* for a Google session.
    vi.mocked(getToken).mockResolvedValue({ accessToken: "ya29.google" } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ id: "sess2" }, { status: 201 }));

    const response = await POST(postRequest({ repoOwner: "o", repoName: "r", model: "m" }));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      authProvider: "google",
      authUserId: "google-sub-1",
      authEmail: "pm@gmail.com",
      userId: "google-sub-1",
    });
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmLogin).toBeUndefined();
    expect(sent.scmEmail).toBeUndefined();
  });
});
