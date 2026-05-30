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
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

function request(path: string) {
  return {
    nextUrl: new URL(`http://localhost${path}`),
  } as NextRequest;
}

describe("sessions API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(request("/api/sessions?limit=50"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards allowed session query params and drops scope=all", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], hasMore: false }, { status: 200 })
    );

    const response = await GET(
      request(
        "/api/sessions?debug=true&limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef&scope=all"
      )
    );

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/sessions?limit=10&offset=20&excludeStatus=archived&createdBy=0123456789abcdef0123456789abcdef"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [], hasMore: false });
  });

  it("resolves scope=mine before forwarding sessions to the control plane", async () => {
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
      request("/api/sessions?limit=50&offset=0&excludeStatus=archived&scope=mine")
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

  it("returns 409 when scope=mine cannot resolve a GitHub user ID", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: "ada@example.com" } } as never);

    const response = await GET(request("/api/sessions?scope=mine"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "GitHub user ID is unavailable" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects unknown scopes", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);

    const response = await GET(request("/api/sessions?scope=team"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid scope" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects combining scope=mine with explicit creator filters", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);

    const response = await GET(
      request("/api/sessions?scope=mine&createdBy=0123456789abcdef0123456789abcdef")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "scope=mine cannot be combined with createdBy",
    });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
