import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";

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

  const env = {
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
  return { env, doFetch: fetch };
}

describe("router sandbox-token fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid sandbox token on a sandbox-accepting route", async () => {
    const { env } = createEnv(204);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer valid-sandbox-token" },
      }),
      env as never
    );

    expect(response.status).toBe(202);
  });

  it("rejects when sandbox verification also fails", async () => {
    const { env } = createEnv(401);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer invalid-token" },
      }),
      env as never
    );

    expect(response.status).toBe(401);
  });

  it("rejects unrecognized credentials on a non-sandbox route without trying sandbox auth", async () => {
    const { env, doFetch } = createEnv(401);

    const response = await handleRequest(
      new Request("https://test.local/analytics/summary", {
        headers: { Authorization: "Bearer invalid-token" },
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
