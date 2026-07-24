import type { NextRequest } from "next/server";
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

// NOTE: @/lib/build-auth-identity is intentionally NOT mocked — these tests
// exercise the real chokepoint to prove the route's outgoing body is correct.
import { getServerSession } from "next-auth";
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
  repositories: [{ repoOwner: "o", repoName: "r" }],
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

  it("sends auth* display and scm* attribution for a GitHub user — never identity or credentials", async () => {
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
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto1" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ method: "POST" })
    );
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      name: "Daily sync",
      repositories: [{ repoOwner: "o", repoName: "r" }],
      authEmail: "ada@example.com",
      authName: "Ada Lovelace",
      authAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
      scmEmail: "ada@example.com",
      scmAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    // Forbidden under strict identity enforcement: the control plane derives
    // created_by from the Bearer principal.
    expect(sent.userId).toBeUndefined();
    expect(sent.spawnSource).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmRefreshToken).toBeUndefined();
    expect(sent.scmTokenExpiresAt).toBeUndefined();
  });

  it("sends auth* display but no scm* for a Google user (F1/F2: a Google sub must never become a GitHub identity)", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "google-sub-1",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
        provider: "google",
      },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto2" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      authEmail: "pm@gmail.com",
      authName: "Pat PM",
    });
    expect(sent.userId).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
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

  it("drops non-allowlisted fields (including client-asserted identity) from the forwarded body", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "ada", provider: "github" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto3" } }, { status: 201 })
    );

    const response = await POST(
      postRequest({
        ...validBody,
        userId: "attacker",
        spawnSource: "user",
        authProvider: "github",
        authUserId: "someone-else",
        actorUserId: "someone-else",
        scmUserId: "someone-else",
        scmToken: "gho_forged",
        scmRefreshToken: "ghr_forged",
      })
    );

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent.name).toBe("Daily sync");
    expect(sent.userId).toBeUndefined();
    expect(sent.spawnSource).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
    expect(sent.actorUserId).toBeUndefined();
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmRefreshToken).toBeUndefined();
  });
});
