import { beforeEach, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "one" } } as never);
});
const request = (body: string) =>
  new Request("http://localhost/api/sessions/batch-archive", {
    method: "POST",
    body,
  }) as NextRequest;

it("rejects unauthenticated callers before forwarding", async () => {
  vi.mocked(getServerAuthSession).mockResolvedValue(null);
  expect((await POST(request("{}"))).status).toBe(401);
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
it("rejects malformed JSON before forwarding", async () => {
  expect((await POST(request("{"))).status).toBe(400);
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
it.each([200, 400, 403, 503])("preserves upstream status %i and body", async (status) => {
  const body = { results: [{ sessionId: "one", outcome: "failed" }] };
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(body, { status }));
  const response = await POST(request('{"sessionIds":["one"]}'));
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/batch-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"sessionIds":["one"]}',
  });
});
