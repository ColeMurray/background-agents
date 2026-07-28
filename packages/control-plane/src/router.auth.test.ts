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
    ...TEST_SERVICE_SECRETS,
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

describe("router service authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows an explicitly authorized service route", async () => {
    const { env, doFetch } = createEnv(202);
    env.SCM_PROVIDER = "github";

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/stop", {
        method: "POST",
        service: "linear-bot",
      }),
      env as never
    );

    expect(response.status).toBe(202);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("denies an authenticated service that is not authorized for the route", async () => {
    const { env, doFetch } = createEnv(202);
    env.SCM_PROVIDER = "github";

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/stop", {
        method: "POST",
        service: "modal",
      }),
      env as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("does not let a bot substitute another integration id", async () => {
    const { env } = createEnv(202);
    env.SCM_PROVIDER = "github";

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/integration-settings/github", {
        service: "slack-bot",
      }),
      env as never
    );

    expect(response.status).toBe(403);
  });

  it("does not let one bot post another bot's internal event", async () => {
    const { env } = createEnv(202);
    env.SCM_PROVIDER = "github";

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/internal/github-event", {
        method: "POST",
        body: "{}",
        service: "slack-bot",
      }),
      env as never
    );

    expect(response.status).toBe(403);
  });
});

describe("retired browser-auth routes", () => {
  it.each([
    ["POST", "/auth/tokens/exchange"],
    ["POST", "/auth/tokens/refresh"],
    ["PUT", "/provider-identities/github/583231"],
  ])("does not expose %s %s", async (method, path) => {
    const { env } = createEnv(401);
    const response = await handleRequest(
      new Request(`https://test.local${path}`, { method }),
      env as never
    );

    expect(response.status).toBe(404);
  });
});
