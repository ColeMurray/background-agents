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

  it("returns 401 when the session is missing", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("sends only provider-independent display data", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ token: "ws-tok" }, { status: 200 })
    );

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/sess1/ws-token",
      expect.objectContaining({ method: "POST" })
    );
    expect(sentBody()).toEqual({
      authName: "Ada Lovelace",
    });
  });

  it("uses the same body shape regardless of sign-in provider", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: {
        id: "fedcba9876543210fedcba9876543210",
        name: "Pat PM",
        email: "pm@gmail.com",
        image: "https://lh3.googleusercontent.com/a/pat",
      },
    } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ token: "ws-tok" }, { status: 200 })
    );

    const response = await POST(request(), params("sess2"));

    expect(response.status).toBe(200);
    expect(sentBody()).toEqual({ authName: "Pat PM" });
  });
});
