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
import { DELETE, GET, PUT } from "./route";

describe("commit signing BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ["GET", () => GET()],
    [
      "PUT",
      () =>
        PUT(
          new Request("https://test.local/api/commit-signing", {
            method: "PUT",
            body: JSON.stringify({ privateKey: "secret" }),
          }) as NextRequest
        ),
    ],
    ["DELETE", () => DELETE()],
  ])("rejects unauthenticated %s before contacting the control plane", async (_method, call) => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards authenticated reads with no-store", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ enabled: false }));

    const response = await GET();

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/commit-signing", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("forwards authenticated writes without persisting or reshaping the key", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Invalid commit signing configuration" }, { status: 400 })
    );
    const body = {
      privateKey: "PRIVATE-KEY-BYTES",
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
    };

    const response = await PUT(
      new Request("https://test.local/api/commit-signing", {
        method: "PUT",
        body: JSON.stringify(body),
      }) as NextRequest
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/commit-signing", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Invalid commit signing configuration" });
  });

  it("forwards authenticated disables with no-store", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ enabled: false }));

    const response = await DELETE();

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/commit-signing", { method: "DELETE" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed successful metadata from the control plane", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ enabled: true }));

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Invalid commit signing service response" });
  });

  it("does not relay unexpected control-plane error bodies", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "PRIVATE-KEY-BYTES leaked" }, { status: 500 })
    );

    const response = await DELETE();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Commit signing request failed" });
  });
});
