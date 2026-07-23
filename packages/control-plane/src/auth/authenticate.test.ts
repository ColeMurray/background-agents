import { describe, expect, it, vi } from "vitest";
import {
  ACTOR_HEADER,
  buildServiceAuthHeaders,
  generateInternalToken,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  type ServiceName,
} from "@open-inspect/shared";

import { authenticate, isAuthError, SERVICE_REQUEST_MAX_BODY_BYTES } from "./authenticate";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";

const SECRETS = {
  SERVICE_AUTH_SECRET_WEB: "web-secret",
  SERVICE_AUTH_SECRET_SLACK_BOT: "slack-secret",
  SERVICE_AUTH_SECRET_GITHUB_BOT: "github-secret",
  SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-secret",
  SERVICE_AUTH_SECRET_MODAL: "modal-secret",
};

const SERVICE_SECRET: Record<ServiceName, string> = {
  web: SECRETS.SERVICE_AUTH_SECRET_WEB,
  "slack-bot": SECRETS.SERVICE_AUTH_SECRET_SLACK_BOT,
  "github-bot": SECRETS.SERVICE_AUTH_SECRET_GITHUB_BOT,
  "linear-bot": SECRETS.SERVICE_AUTH_SECRET_LINEAR_BOT,
  modal: SECRETS.SERVICE_AUTH_SECRET_MODAL,
};

function createCtx(identityRow: Record<string, unknown> | null = null): RequestContext {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => identityRow),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  return {
    trace_id: "trace-test",
    request_id: "req-test",
    metrics: { summarize: () => ({}) },
    db: { prepare: vi.fn(() => statement), batch: vi.fn(), exec: vi.fn() },
  } as unknown as RequestContext;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...SECRETS,
    ...overrides,
  } as Env;
}

async function signedRequest(p: {
  service: ServiceName;
  method?: string;
  url?: string;
  body?: string;
  actor?: string;
  secret?: string;
  mutate?: (headers: Record<string, string>) => void;
}): Promise<Request> {
  const method = p.method ?? "POST";
  const url = p.url ?? "https://cp.test.local/sessions";
  const headers = await buildServiceAuthHeaders({
    service: p.service,
    secret: p.secret ?? SERVICE_SECRET[p.service],
    method,
    url,
    body: p.body,
    actor: p.actor,
  });
  p.mutate?.(headers);
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : p.body,
  });
}

describe("authenticate — service credentials", () => {
  it("resolves a valid signed request to a per-service principal", async () => {
    const body = JSON.stringify({ prompt: "hello" });
    const request = await signedRequest({ service: "modal", body });
    const result = await authenticate(request, createEnv(), createCtx());

    expect(isAuthError(result)).toBe(false);
    if (isAuthError(result)) return;
    expect(result.principal).toEqual({
      kind: "service",
      service: "modal",
      actor: null,
    });
    // The handler must still be able to read the body after hashing.
    expect(await result.request.json()).toEqual({ prompt: "hello" });
  });

  it("accepts every registered service with its own secret", async () => {
    for (const service of Object.keys(SERVICE_SECRET) as ServiceName[]) {
      const request = await signedRequest({ service, body: "{}" });
      const result = await authenticate(request, createEnv(), createCtx());
      expect(isAuthError(result), service).toBe(false);
    }
  });

  it("passes bodyless requests through without rebuilding", async () => {
    const request = await signedRequest({ service: "web", method: "GET" });
    const result = await authenticate(request, createEnv(), createCtx());
    expect(isAuthError(result)).toBe(false);
    if (isAuthError(result)) return;
    expect(result.request).toBe(request);
  });

  it("resolves an asserted actor against D1 identities", async () => {
    const ctx = createCtx({
      id: "ident-1",
      user_id: "user-1",
      provider: "slack",
      provider_user_id: "U0123456",
      provider_login: null,
      provider_email: null,
      created_at: 1,
    });
    const request = await signedRequest({
      service: "slack-bot",
      body: "{}",
      actor: "slack:U0123456",
    });
    const result = await authenticate(request, createEnv(), ctx);

    expect(isAuthError(result)).toBe(false);
    if (isAuthError(result)) return;
    expect(result.principal).toEqual({
      kind: "service",
      service: "slack-bot",
      actor: {
        provider: "slack",
        providerUserId: "U0123456",
        canonicalUserId: "user-1",
        participantUserId: "slack:U0123456",
      },
    });
  });

  it("keeps canonicalUserId null for actors the CP has never seen", async () => {
    const request = await signedRequest({
      service: "linear-bot",
      body: "{}",
      actor: "linear:usr_9",
    });
    const result = await authenticate(request, createEnv(), createCtx(null));
    expect(isAuthError(result)).toBe(false);
    if (isAuthError(result)) return;
    expect(result.principal).toMatchObject({
      actor: { canonicalUserId: null, participantUserId: "linear:usr_9" },
    });
  });

  it("rejects an unknown service name without fallback", async () => {
    const request = await signedRequest({
      service: "modal",
      body: "{}",
      mutate: (headers) => {
        headers[SERVICE_HEADER] = "sandbox";
      },
    });
    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({ reason: "Unauthorized", status: 401, failedScheme: "per-service" });
  });

  it("fails 500 when the named service's secret is not bound", async () => {
    const request = await signedRequest({ service: "modal", body: "{}" });
    const result = await authenticate(
      request,
      createEnv({ SERVICE_AUTH_SECRET_MODAL: undefined }),
      createCtx()
    );
    expect(result).toEqual({
      reason: "Service authentication not configured",
      status: 500,
      failedScheme: "per-service",
    });
  });

  it("rejects tampered bodies, methods, and actors as 401 without fallback", async () => {
    const tamperings: Array<() => Promise<Request>> = [
      // Body swapped after signing
      async () => {
        const headers = await buildServiceAuthHeaders({
          service: "modal",
          secret: SERVICE_SECRET.modal,
          method: "POST",
          url: "https://cp.test.local/sessions",
          body: '{"a":1}',
        });
        return new Request("https://cp.test.local/sessions", {
          method: "POST",
          headers,
          body: '{"a":2}',
        });
      },
      // Actor header rewritten after signing
      () =>
        signedRequest({
          service: "slack-bot",
          body: "{}",
          actor: "slack:U1",
          mutate: (headers) => {
            headers[ACTOR_HEADER] = "slack:U2";
          },
        }),
      // Signed with the wrong service's secret
      () => signedRequest({ service: "modal", body: "{}", secret: SERVICE_SECRET.web }),
    ];
    for (const build of tamperings) {
      const result = await authenticate(await build(), createEnv(), createCtx());
      expect(result).toEqual({
        reason: "Unauthorized",
        status: 401,
        failedScheme: "per-service",
      });
    }
  });

  it("rejects a malformed signature header without reading the body", async () => {
    const request = new Request("https://cp.test.local/sessions", {
      method: "POST",
      headers: {
        [SERVICE_HEADER]: "modal",
        [SERVICE_SIGNATURE_HEADER]: "sig1.not-a-timestamp.nonce.sig",
      },
      body: "{}",
    });

    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({ reason: "Unauthorized", status: 401, failedScheme: "per-service" });
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects an over-cap body as 413 before signature verification", async () => {
    const url = "https://cp.test.local/sessions";
    const headers = await buildServiceAuthHeaders({
      service: "modal",
      secret: SERVICE_SECRET.modal,
      method: "POST",
      url,
      body: "{}",
    });
    const request = new Request(url, {
      method: "POST",
      headers,
      body: new Uint8Array(SERVICE_REQUEST_MAX_BODY_BYTES + 1),
    });

    // 413 (not the 401 this body mismatch would earn) proves the cap runs first.
    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({
      reason: "Request body too large",
      status: 413,
      failedScheme: "per-service",
    });
  });

  it("rejects expired signatures", async () => {
    const request = await signedRequest({ service: "modal", body: "{}" });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      const result = await authenticate(request, createEnv(), createCtx());
      expect(result).toEqual({
        reason: "Unauthorized",
        status: 401,
        failedScheme: "per-service",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("denies actor assertions outside the service's namespace", async () => {
    const cases: Array<{ service: ServiceName; actor: string }> = [
      { service: "web", actor: "slack:U1" },
      { service: "modal", actor: "github:1" },
      { service: "slack-bot", actor: "github:1" },
      { service: "github-bot", actor: "linear:usr_1" },
      { service: "linear-bot", actor: "slack:U1" },
      { service: "slack-bot", actor: "malformed" },
    ];
    for (const { service, actor } of cases) {
      const request = await signedRequest({ service, body: "{}", actor });
      const result = await authenticate(request, createEnv(), createCtx());
      expect(result, `${service} asserting ${actor}`).toEqual({
        reason: "Unauthorized",
        status: 401,
        failedScheme: "per-service",
      });
    }
  });

  it("a failed service-signature attempt is terminal even with a bearer alongside", async () => {
    const request = await signedRequest({
      service: "modal",
      body: "{}",
      secret: "wrong-secret",
      mutate: (headers) => {
        headers["Authorization"] = "Bearer some-other-credential";
      },
    });
    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({ reason: "Unauthorized", status: 401, failedScheme: "per-service" });
  });
});

describe("authenticate — nonce replay logging", () => {
  it("warns on nonce reuse inside the validity window but still authenticates", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const url = "https://cp.test.local/sessions";
      const body = "{}";
      const headers = await buildServiceAuthHeaders({
        service: "modal",
        secret: SERVICE_SECRET.modal,
        method: "POST",
        url,
        body,
      });
      const build = () => new Request(url, { method: "POST", headers: { ...headers }, body });

      const first = await authenticate(build(), createEnv(), createCtx());
      expect(isAuthError(first)).toBe(false);
      const reuseLogged = () =>
        warnSpy.mock.calls.some((call) => JSON.stringify(call).includes("auth.nonce_reuse"));
      expect(reuseLogged()).toBe(false);

      // Log-only detection: the replay is observed, not rejected.
      const second = await authenticate(build(), createEnv(), createCtx());
      expect(isAuthError(second)).toBe(false);
      expect(reuseLogged()).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("authenticate — web session token dispatch", () => {
  it("dispatches oi_at_ bearers to token verification, never the shared bearer", async () => {
    // An unknown token must fail as a user-token attempt (terminal), even
    // though the same header would otherwise reach the shared-bearer arm.
    const request = new Request("https://cp.test.local/sessions", {
      headers: { Authorization: "Bearer oi_at_unknown-token-value" },
    });
    const result = await authenticate(request, createEnv(), createCtx(null));
    expect(result).toEqual({
      reason: "Unauthorized",
      status: 401,
      failedScheme: "user-token",
    });
  });
});

describe("authenticate — no recognized credential", () => {
  it("rejects a legacy shared bearer: the scheme is retired, not a credential", async () => {
    // A real pre-retirement internal token — must now be indistinguishable
    // from any other unrecognized Authorization value.
    const token = await generateInternalToken("shared-secret");
    const request = new Request("https://cp.test.local/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({ reason: "Unauthorized", status: 401, failedScheme: "none" });
  });

  it("rejects a missing Authorization header (router may still try sandbox auth)", async () => {
    const request = new Request("https://cp.test.local/sessions");
    const result = await authenticate(request, createEnv(), createCtx());
    expect(result).toEqual({ reason: "Unauthorized", status: 401, failedScheme: "none" });
  });
});
