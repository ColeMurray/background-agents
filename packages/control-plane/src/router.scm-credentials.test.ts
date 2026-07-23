import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";

function createEnv() {
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/internal/verify-sandbox-token") {
      const body = (await request.json()) as { token?: string };
      return new Response(null, { status: body.token === "sandbox-token" ? 204 : 401 });
    }
    return Response.json({ ok: true }, { status: 202 });
  });
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  return {
    fetch,
    env: {
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
    },
  };
}

describe("SCM credentials router provider gate", () => {
  it("allows GitLab deployments to reach the SCM credential broker", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
      }),
      env as never
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/internal/scm-credentials");
  });

  it("allows GitLab deployments to reach the tunnel URLs endpoint", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/tunnel-urls"),
      env as never
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/internal/tunnel-urls");
  });

  it("returns an explicit disabled signing state for GitLab sandboxes", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/commit-signing", {
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      env as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ enabled: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe("/internal/verify-sandbox-token");
  });

  it("rejects service authentication for the signing-key broker", async () => {
    const { env } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/commit-signing"),
      env as never
    );

    expect(response.status).toBe(401);
  });

  it("continues blocking unrelated GitLab session routes", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/pr", {
        method: "POST",
      }),
      env as never
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "SCM provider 'gitlab' is not implemented in this deployment.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
