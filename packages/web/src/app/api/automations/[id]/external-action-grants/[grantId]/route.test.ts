import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { DELETE } from "./route";

describe("automation external-action grant revocation BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("revokes one grant inside its automation", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));
    const response = await DELETE(
      new Request("http://local/api/automations/auto-1/external-action-grants/grant-1", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: "auto-1", grantId: "grant-1" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/automations/auto-1/external-action-grants/grant-1",
      { method: "DELETE" }
    );
    expect(response.status).toBe(200);
  });

  it("rejects unauthenticated revocation before control-plane access", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://local/api/automations/auto-1/external-action-grants/grant-1", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: "auto-1", grantId: "grant-1" }) }
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
