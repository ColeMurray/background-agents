import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { GET } from "./route";

describe("sandbox access BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("returns no content when sandbox access is temporarily unavailable", async () => {
    const cancel = vi.fn();
    const upstream = {
      status: 409,
      clone: () => Response.json({ error: "Sandbox access is unavailable" }),
      body: { cancel },
    } as unknown as Response;
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(upstream);

    const response = await GET({} as Request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves access-change conflicts for retry", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Sandbox access changed; retry" }, { status: 409 })
    );

    const response = await GET({} as Request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    await expect(response.json()).resolves.toEqual({ error: "Sandbox access changed; retry" });
  });

  it("preserves unexpected control-plane errors", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Session not found" }, { status: 404 })
    );

    const response = await GET({} as Request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });
});
