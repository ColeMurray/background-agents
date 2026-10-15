import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

function markReadRequest(
  body: unknown,
  headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "http://localhost",
  }
) {
  return new Request("http://localhost/api/sessions/inbox/read-state", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("session inbox read-state BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("forwards the inbox filters to the control plane", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ markedCount: 3 }));

    const response = await POST(markReadRequest({ mine: true, teamIds: ["team_a"] }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ markedCount: 3 });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/inbox/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mine: true, teamIds: ["team_a"] }),
    });
  });

  it("rejects bodies outside the shared request contract", async () => {
    const response = await POST(markReadRequest({ userId: "user-2" }) as never);

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a simple text/plain body", { "Content-Type": "text/plain", Origin: "http://localhost" }],
    ["a cross-origin request", { "Content-Type": "application/json", Origin: "https://evil.test" }],
    ["a request without an Origin", { "Content-Type": "application/json" }],
  ])("rejects %s before parsing", async (_case, headers) => {
    const response = await POST(markReadRequest({}, headers) as never);

    expect(response.status).toBe(403);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("accepts the public host from X-Forwarded-Host behind a proxy", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ markedCount: 0 }));

    const response = await POST(
      markReadRequest(
        {},
        {
          "Content-Type": "application/json; charset=utf-8",
          Origin: "https://inspect.example.com",
          "X-Forwarded-Host": "inspect.example.com",
        }
      ) as never
    );

    expect(response.status).toBe(200);
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(markReadRequest({}) as never);

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
