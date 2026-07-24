import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";

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

describe("auth token routes are SCM-agnostic", () => {
  // Guards the isScmAgnosticRoute entry for /auth/tokens/*: dropping it would
  // 501 exchange/refresh on non-GitHub deployments before the handlers run.
  it.each(["exchange", "refresh"])(
    "reaches /auth/tokens/%s under a gitlab provider",
    async (route) => {
      const env = {
        ...TEST_SERVICE_SECRETS,
        SCM_PROVIDER: "gitlab",
        DB: { prepare: vi.fn(), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() },
      };

      const response = await handleRequest(
        await signedServiceRequest(`https://test.local/auth/tokens/${route}`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        env as never
      );

      // 400 = the handler's schema rejection; the SCM gate (501) did not fire.
      expect(response.status).toBe(400);
    }
  );
});
