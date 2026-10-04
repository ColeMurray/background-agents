import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PATCH, PUT } from "./route";

describe("automation update BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ automation: {} }));
  });

  it("forwards providerSelections but strips hydrated auth and identity", async () => {
    const providerSelections = { xai: { mode: "api_key" } };
    await PUT(
      {
        json: async () => ({
          name: "Updated",
          harness: "claude",
          providerSelections,
          providerAuth: [{ token: "secret" }],
          createdBy: "attacker",
          teamId: "team-1",
        }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ id: "auto-1" }) }
    );

    const body = JSON.parse(String(vi.mocked(controlPlaneUserFetch).mock.calls[0][1]?.body));
    expect(body).toEqual({ name: "Updated", harness: "claude", providerSelections });
  });

  it("forwards executor changes separately from configuration", async () => {
    await PATCH(
      {
        json: async () => ({ userId: "user-2", teamId: "team-1", name: "Injected" }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ id: "auto-1" }) }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/automations/auto-1", {
      method: "PATCH",
      body: JSON.stringify({ userId: "user-2" }),
    });
  });
});
