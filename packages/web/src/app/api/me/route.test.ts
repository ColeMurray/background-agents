import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { clearCurrentUserIdCacheForTests } from "@/lib/current-user";
import { GET } from "./route";

describe("current user API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCurrentUserIdCacheForTests();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("returns 409 when the GitHub user ID is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: "ada@example.com" } } as never);

    const response = await GET();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "GitHub user ID is unavailable" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("resolves the signed-in GitHub user through the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ userId: "0123456789abcdef0123456789abcdef" })
    );

    const response = await GET();

    expect(controlPlaneFetch).toHaveBeenCalledWith("/provider-identities/github/12345", {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("falls back to login for displayName", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: null,
        email: null,
        image: null,
      },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ userId: "0123456789abcdef0123456789abcdef" })
    );

    const response = await GET();

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/provider-identities/github/12345",
      expect.objectContaining({
        body: JSON.stringify({
          providerLogin: "ada",
          providerEmail: null,
          displayName: "ada",
          avatarUrl: null,
        }),
      })
    );
  });

  it("forwards control-plane errors", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ error: "providerUserId is required" }, { status: 400 })
    );

    const response = await GET();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "providerUserId is required" });
  });

  it("rejects invalid current user responses", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ userId: "user-1" }));

    const response = await GET();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid current user response" });
  });

  it("returns 500 when the control-plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("boom"));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to resolve current user" });
  });
});
