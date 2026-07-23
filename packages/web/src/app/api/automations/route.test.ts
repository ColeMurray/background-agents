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

// NOTE: @/lib/build-auth-identity is intentionally NOT mocked — these tests
// exercise the real chokepoint to prove the route's outgoing body is correct.
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { controlPlaneFetch } from "@/lib/control-plane";
import { POST } from "./route";

function postRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as NextRequest;
}

function controlPlaneBody(callIndex = 0): Record<string, unknown> {
  const options = vi.mocked(controlPlaneFetch).mock.calls[callIndex]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

const validBody = {
  name: "Daily sync",
  repoOwner: "o",
  repoName: "r",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  instructions: "Run tests",
};

describe("automations API route (POST)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("sends auth* and scm* for a GitHub user", async () => {
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
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto1" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneBody()).toMatchObject({
      name: "Daily sync",
      repoOwner: "o",
      repoName: "r",
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

  it("sends auth* but no scm* for a Google user (F1/F2: a Google sub must never become a GitHub identity)", async () => {
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
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto2" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      authProvider: "google",
      authUserId: "google-sub-1",
      authEmail: "pm@gmail.com",
      userId: "google-sub-1",
    });
    // Regression guard: the bug sent scmUserId = user.id = the Google sub, which
    // the control plane then stored under provider='github'. After the fix there
    // is no scm* block at all for a Google user.
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmLogin).toBeUndefined();
    expect(sent.scmName).toBeUndefined();
    expect(sent.scmEmail).toBeUndefined();
    expect(sent.scmAvatarUrl).toBeUndefined();
  });
});
