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

it("preserves retry and correlation headers on an empty upstream response", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    new Response(null, {
      status: 503,
      headers: { "retry-after": "5", "x-request-id": "request-123" },
    })
  );
  const response = await POST(request('{"sessionIds":["one"]}'));
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("");
  expect(response.headers.get("retry-after")).toBe("5");
  expect(response.headers.get("x-request-id")).toBe("request-123");
});

it("rejects oversized bodies before parsing or forwarding", async () => {
  expect((await POST(request(" ".repeat(48 * 1024 + 1)))).status).toBe(413);
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});

it("caps and cancels chunked bodies without trusting content-length", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel,
  });
  const streamed = new Request("http://localhost/api/sessions/batch-archive", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-length": "1" },
  } as RequestInit) as NextRequest;
  expect((await POST(streamed)).status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
