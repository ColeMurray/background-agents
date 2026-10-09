import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal";
import type { RequestContext } from "../http/request-context";
import { logPrincipal } from "./request-lifecycle";

function requestContext(): RequestContext {
  return {
    request_id: "request-123",
    trace_id: "trace-456",
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, operation: () => Promise<T>): Promise<T> => operation(),
      summarize: () => ({}),
    },
  } as unknown as RequestContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request lifecycle logging", () => {
  it("attributes an access-token request to its user and token", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const principal = {
      kind: "access-token",
      userId: "user-1",
      tokenId: "token-1",
    } satisfies Principal;

    logPrincipal(principal, requestContext(), "/sessions/session-1");

    const events = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "auth.principal",
        service: "control-plane",
        http_path: "/sessions/session-1",
        request_id: "request-123",
        trace_id: "trace-456",
        principal_kind: "access-token",
        auth_scheme: "access-token",
        user_id: "user-1",
        token_id: "token-1",
      })
    );
  });
});
