import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal";
import type { RequestContext } from "../http/request-context";
import type { AdmissionPolicy } from "./admit";
import {
  logPrincipal,
  logRequest,
  finalizeRouteResponse,
  withCorsAndTraceHeaders,
} from "./request-lifecycle";

function requestContext(metrics: Record<string, unknown> = {}): RequestContext {
  return {
    request_id: "request-123",
    trace_id: "trace-456",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, operation: () => Promise<T>): Promise<T> => operation(),
      summarize: () => metrics,
    },
  } as unknown as RequestContext;
}

function route(
  cacheControl?: AdmissionPolicy["cacheControl"]
): Pick<AdmissionPolicy, "cacheControl"> {
  return { cacheControl };
}

function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => {
    const [line] = call;
    return JSON.parse(String(line)) as Record<string, unknown>;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("response finalization", () => {
  it("adds common CORS and correlation headers without changing the response payload", async () => {
    const response = new Response("created", {
      status: 201,
      statusText: "Created here",
      headers: {
        "Access-Control-Allow-Origin": "https://old.example",
        "Content-Type": "text/plain",
        "x-request-id": "old-request",
        "x-trace-id": "old-trace",
      },
    });

    const finalized = withCorsAndTraceHeaders(response, requestContext());

    expect(finalized).not.toBe(response);
    expect(finalized.status).toBe(201);
    expect(finalized.statusText).toBe("Created here");
    expect(finalized.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(finalized.headers.get("Content-Type")).toBe("text/plain");
    expect(finalized.headers.get("x-request-id")).toBe("request-123");
    expect(finalized.headers.get("x-trace-id")).toBe("trace-456");
    await expect(finalized.text()).resolves.toBe("created");
  });

  it("applies common headers and overrides a route-owned cache policy in one pass", async () => {
    const response = new Response("private", {
      status: 202,
      headers: { "Cache-Control": "public, max-age=3600", ETag: '"v1"' },
    });

    const finalized = finalizeRouteResponse(response, route("private, no-store"), requestContext());

    expect(finalized).not.toBe(response);
    expect(finalized.status).toBe(202);
    expect(finalized.headers.get("Cache-Control")).toBe("private, no-store");
    expect(finalized.headers.get("ETag")).toBe('"v1"');
    expect(finalized.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(finalized.headers.get("x-request-id")).toBe("request-123");
    expect(finalized.headers.get("x-trace-id")).toBe("trace-456");
    await expect(finalized.text()).resolves.toBe("private");
  });
});

describe("request lifecycle logging", () => {
  it.each([
    [
      { kind: "user", userId: "user-1" } satisfies Principal,
      { principal_kind: "user", user_id: "user-1" },
    ],
    [
      { kind: "sandbox", sessionId: "session-1" } satisfies Principal,
      { principal_kind: "sandbox", session_id: "session-1" },
    ],
    [
      {
        kind: "service",
        service: "slack-bot",
        actor: {
          provider: "slack",
          providerUserId: "U123",
          canonicalUserId: "user-1",
          participantUserId: "slack:U123",
        },
      } satisfies Principal,
      {
        principal_kind: "service",
        auth_scheme: "per-service",
        principal_service: "slack-bot",
        actor: "slack:U123",
      },
    ],
  ])("logs verified %s attribution with correlation fields", (principal, expected) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logPrincipal(principal, requestContext(), "/sessions/session-1");

    expect(loggedEvents(consoleLog)).toContainEqual(
      expect.objectContaining({
        event: "auth.principal",
        service: "control-plane",
        http_path: "/sessions/session-1",
        request_id: "request-123",
        trace_id: "trace-456",
        ...expected,
      })
    );
  });

  it.each([
    [204, "success"],
    [500, "error"],
  ])("logs status %i as a %s outcome with request metrics", (status, outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_250);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logRequest(
      new Response(null, { status }),
      requestContext({ d1_query_count: 2, d1_total_ms: 7 }),
      "POST",
      "/sessions",
      1_000
    );

    expect(loggedEvents(consoleLog)).toContainEqual(
      expect.objectContaining({
        event: "http.request",
        request_id: "request-123",
        trace_id: "trace-456",
        http_method: "POST",
        http_path: "/sessions",
        http_status: status,
        duration_ms: 250,
        outcome,
        d1_query_count: 2,
        d1_total_ms: 7,
      })
    );
  });
});
