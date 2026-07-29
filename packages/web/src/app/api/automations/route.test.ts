import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

// NOTE: @/lib/build-auth-identity is intentionally NOT mocked — these tests
// exercise the real chokepoint to prove the route's outgoing body is correct.
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

function postRequest(body: unknown) {
  return {
    json: async () => body,
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

  it("sends cosmetic auth display without identity or SCM assertions", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
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
    expect(sent).toMatchObject({
      name: "Daily sync",
      repositories: [{ repoOwner: "o", repoName: "r" }],
      actorEmail: "ada@example.com",
      actorDisplayName: "Ada Lovelace",
      actorAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
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

  it("uses the same display-only shape for another provider", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "fedcba9876543210fedcba9876543210",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
      },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ automation: { id: "auto2" } }, { status: 201 })
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(201);
    const sent = controlPlaneBody();
    expect(sent).toMatchObject({
      actorEmail: "pm@gmail.com",
      actorDisplayName: "Pat PM",
    });
    expect(sent.userId).toBeUndefined();
    expect(sent.authProvider).toBeUndefined();
    expect(sent.authUserId).toBeUndefined();
    // Provider identity and SCM provenance come from control-plane auth state.
    expect(sent.scmUserId).toBeUndefined();
    expect(sent.scmToken).toBeUndefined();
    expect(sent.scmLogin).toBeUndefined();
    expect(sent.scmName).toBeUndefined();
    expect(sent.scmEmail).toBeUndefined();
    expect(sent.scmAvatarUrl).toBeUndefined();
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
