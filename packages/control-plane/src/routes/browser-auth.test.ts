import { describe, expect, it, vi } from "vitest";
import { forwardBrowserAuthRequest } from "./browser-auth";

describe("forwardBrowserAuthRequest", () => {
  it("uses the direct API wrapper for session lookup", async () => {
    const getSession = vi.fn(async () => Response.json({ user: { id: "user-1" } }));
    const handler = vi.fn(async () => {
      throw new Error("HTTP handler should not serve session lookup");
    });
    const auth = {
      api: { getSession },
      handler,
    } as never;
    const request = new Request("https://control-plane.test/api/auth/get-session", {
      headers: { Cookie: "session=value" },
    });

    const response = await forwardBrowserAuthRequest(auth, request);

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledWith({
      headers: request.headers,
      asResponse: true,
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
