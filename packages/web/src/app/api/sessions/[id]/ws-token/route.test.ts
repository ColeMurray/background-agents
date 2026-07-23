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

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { POST } from "./route";

function request() {
  return {} as NextRequest;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function sentBody(): Record<string, unknown> {
  const options = vi.mocked(controlPlaneFetch).mock.calls[0]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("ws-token API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("sends scm* attribution for a GitHub user — never userId or credentials (forbidden under strict)", async () => {
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
      Response.json({ token: "ws-tok" }, { status: 200 })
    );

    const response = await POST(request(), params("sess1"));

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/sessions/sess1/ws-token",
      expect.objectContaining({ method: "POST" })
    );
    expect(sentBody()).toEqual({
      authName: "Ada Lovelace",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
      scmEmail: "ada@example.com",
      scmAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
  });

  it("omits scm* entirely for a Google user — identity comes from the Bearer principal", async () => {
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
      Response.json({ token: "ws-tok" }, { status: 200 })
    );

    const response = await POST(request(), params("sess2"));

    expect(response.status).toBe(200);
    expect(sentBody()).toEqual({ authName: "Pat PM" });
  });
});
