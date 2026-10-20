import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, POST } from "./route";

describe("automation external-action grants BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("lists the grants an automation holds", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ grants: [] }));
    const response = await GET(
      new Request("http://local/api/automations/auto-1/external-action-grants") as never,
      { params: Promise.resolve({ id: "auto-1" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations/auto-1/external-action-grants"
    );
    expect(response.status).toBe(200);
  });

  it("creates a grant", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ grant: { id: "grant-1" } }));
    const response = await POST(
      new Request("http://local/api/automations/auto-1/external-action-grants", {
        method: "POST",
        body: JSON.stringify({ provider: "github", action: "comment" }),
      }) as never,
      { params: Promise.resolve({ id: "auto-1" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations/auto-1/external-action-grants",
      expect.objectContaining({ method: "POST" })
    );
    expect(response.status).toBe(200);
  });

  it("rejects unauthenticated access before control-plane access", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await GET(
      new Request("http://local/api/automations/auto-1/external-action-grants") as never,
      { params: Promise.resolve({ id: "auto-1" }) }
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
