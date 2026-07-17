import { describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const secret = "test-internal-secret";

function createEnv() {
  const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }, { status: 202 }));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  return {
    fetch,
    env: {
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
    },
  };
}

describe("SCM credentials router provider gate", () => {
  it("allows GitLab deployments to reach the SCM credential broker", async () => {
    const { env, fetch } = createEnv();
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/tunnel-urls", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as never
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/internal/tunnel-urls");
  });

  it("returns an explicit disabled signing state for GitLab sandboxes", async () => {
    const { env } = createEnv();
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/commit-signing", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });

  it("continues blocking unrelated GitLab session routes", async () => {
    const { env, fetch } = createEnv();
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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
