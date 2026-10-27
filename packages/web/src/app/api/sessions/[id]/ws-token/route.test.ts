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
import { POST } from "./route";

function request() {
  return {} as NextRequest;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function sentBody(): Record<string, unknown> {
  const options = vi.mocked(controlPlaneUserFetch).mock.calls[0]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("ws-token API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("preserves a control-plane 401 without a separate session lookup", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Failed to generate token" });
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });

  it("sends an empty token request without resolving a user profile", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ token: "ws-tok" }, { status: 200 })
    );

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/sess1/ws-token",
      expect.objectContaining({ method: "POST" })
    );
    expect(sentBody()).toEqual({});
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });
});
