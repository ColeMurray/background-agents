import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PUT } from "./route";

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
          providerSelections,
          providerAuth: [{ token: "secret" }],
          createdBy: "attacker",
        }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ id: "auto-1" }) }
    );

    const body = JSON.parse(String(vi.mocked(controlPlaneUserFetch).mock.calls[0][1]?.body));
    expect(body).toEqual({ name: "Updated", providerSelections });
  });
});
