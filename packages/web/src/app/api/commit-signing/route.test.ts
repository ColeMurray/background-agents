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
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards authenticated reads with no-store", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ enabled: false }));

    const response = await GET();

    expect(controlPlaneFetch).toHaveBeenCalledWith("/commit-signing", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("forwards authenticated writes without persisting or reshaping the key", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
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

    expect(controlPlaneFetch).toHaveBeenCalledWith("/commit-signing", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Invalid commit signing configuration" });
  });

  it("forwards authenticated disables with no-store", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ enabled: false }));

    const response = await DELETE();

    expect(controlPlaneFetch).toHaveBeenCalledWith("/commit-signing", { method: "DELETE" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed successful metadata from the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ enabled: true }));

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Invalid commit signing service response" });
  });

  it("does not relay unexpected control-plane error bodies", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ error: "PRIVATE-KEY-BYTES leaked" }, { status: 500 })
    );

    const response = await DELETE();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Commit signing request failed" });
  });
});
