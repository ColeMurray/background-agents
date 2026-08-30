import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PATCH } from "./route";

describe("session budget BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("forwards a validated limit update", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ totalCost: 2, maxSessionCostUsd: 10, budgetExhausted: false })
    );
    const request = new Request("http://localhost/api/sessions/session-1/budget", {
      method: "PATCH",
      body: JSON.stringify({ maxCostUsd: 10 }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/budget", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxCostUsd: 10 }),
    });
  });

  it.each([{ maxCostUsd: 0 }, { maxCostUsd: 1, userId: "other" }, {}])(
    "rejects invalid input %#",
    async (body) => {
      const request = new Request("http://localhost/api/sessions/session-1/budget", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const response = await PATCH(request as never, {
        params: Promise.resolve({ id: "session-1" }),
      });
      expect(response.status).toBe(400);
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
    }
  );

  it("uses the route error response for malformed JSON", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/sessions/session-1/budget", {
        method: "PATCH",
        body: "{",
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update session budget" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await PATCH(
      new Request("http://localhost/api/sessions/session-1/budget", {
        method: "PATCH",
        body: JSON.stringify({ maxCostUsd: null }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );
    expect(response.status).toBe(401);
  });
});
