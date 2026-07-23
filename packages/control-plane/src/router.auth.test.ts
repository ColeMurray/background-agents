import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";

const secret = "test-internal-secret";

function createEnv(verifyStatus: number) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: verifyStatus }))
    .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  return {
    INTERNAL_CALLBACK_SECRET: secret,
    SCM_PROVIDER: "gitlab",
    GITLAB_ACCESS_TOKEN: "glpat-test",
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch }),
    },
  };
}

function hasHmacFailure(warn: { mock: { calls: unknown[][] } }): boolean {
  return warn.mock.calls.some(([message]: unknown[]) => {
    const entry = JSON.parse(String(message)) as { event?: string };
    return entry.event === "auth.hmac_failed";
  });
}

describe("router authentication telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log an HMAC failure for a valid sandbox token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer valid-sandbox-token" },
      }),
      createEnv(204) as never
    );

    expect(response.status).toBe(202);
    expect(hasHmacFailure(warn)).toBe(false);
  });

  it("logs an HMAC failure when all accepted authentication schemes fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer invalid-token" },
      }),
      createEnv(401) as never
    );

    expect(response.status).toBe(401);
    expect(hasHmacFailure(warn)).toBe(true);
  });

  it("logs an HMAC failure for a non-sandbox route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handleRequest(
      new Request("https://test.local/analytics/summary", {
        headers: { Authorization: "Bearer invalid-token" },
      }),
      createEnv(401) as never
    );

    expect(response.status).toBe(401);
    expect(hasHmacFailure(warn)).toBe(true);
  });
});
