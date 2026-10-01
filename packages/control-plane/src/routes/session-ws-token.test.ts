import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BACKGROUND_TASK_CONTEXT,
  fakeSessionRuntimeDispatch,
  routePathPattern,
} from "../router.test-support";
import { handleSessionWsToken } from "./session-ws-token";
import type { RequestContext } from "./shared";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { APIError } from "better-auth/api";
import { OAuthProviderError } from "../auth/user/providers/types";
import { AdmissionDeniedError } from "../auth/user/admission-policy";
import { UserStore } from "../db/user-store";
import type { ProviderAccountClient } from "../source-control/github-credential-authority";
import { withSessionRuntime } from "./session-route";

function routeFor(path: string): { handler: typeof handleSessionWsToken; params: { id: string } } {
  const match = path.match(routePathPattern("/sessions/:id/ws-token"));
  if (!match?.groups?.id) throw new Error(`path did not match: ${path}`);
  return { handler: handleSessionWsToken, params: { id: match.groups.id } };
}

function accessDatabase() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const statement = {
    bind: vi.fn(() => statement),
    run,
  };
  return {
    db: { prepare: vi.fn(() => statement) } as unknown as SqlDatabase,
    statement,
    run,
  };
}

function createContext(db: SqlDatabase = accessDatabase().db): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "user", userId: "user-1" },
    authorization: {
      userId: "user-1",
      suspendedAt: null,
      role: { id: "role-1", key: "member", name: "Member" },
      permissions: ["sessions.read"],
    },
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(fetch: (request: Request) => Promise<Response>): Env {
  return {
    SCM_PROVIDER: "gitlab",
    SESSION: fakeSessionRuntimeDispatch(fetch),
  } as unknown as Env;
}

describe("session ws-token route (non-GitHub display fields)", () => {
  it("forwards validated optional SCM display fields", async () => {
    const forwarded: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ token: "token-1" });
    });
    const { handler, params } = routeFor("/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({
          scmLogin: "octocat",
          scmName: "Octo Cat",
          scmEmail: "octo@example.com",
        }),
      }),
      createEnv(fetch),
      params,
      withSessionRuntime(createEnv(fetch), createContext())
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(forwarded[0].json()).resolves.toMatchObject({
      userId: "user-1",
      canonicalUserId: "user-1",
      scmLogin: "octocat",
      scmName: "Octo Cat",
      scmEmail: "octo@example.com",
    });
  });

  it("forwards a runtime rejection without writing D1", async () => {
    const access = accessDatabase();
    const fetch = vi.fn(async () => Response.json({ error: "rejected" }, { status: 409 }));
    const { handler, params } = routeFor("/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      createEnv(fetch),
      params,
      withSessionRuntime(createEnv(fetch), createContext(access.db))
    );

    expect(response.status).toBe(409);
    expect(access.db.prepare).not.toHaveBeenCalled();
  });

  it("forwards null SCM display fields accepted by the session contract", async () => {
    const forwarded: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ token: "token-1" });
    });
    const { handler, params } = routeFor("/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ scmLogin: null, scmName: null, scmEmail: null }),
      }),
      createEnv(fetch),
      params,
      withSessionRuntime(createEnv(fetch), createContext())
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(forwarded[0].json()).resolves.toMatchObject({
      scmLogin: null,
      scmName: null,
      scmEmail: null,
    });
  });

  it("rejects malformed optional SCM display fields", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "token-1" }));
    const { handler, params } = routeFor("/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ scmLogin: 123 }),
      }),
      createEnv(fetch),
      params,
      withSessionRuntime(createEnv(fetch), createContext())
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid websocket token body" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still rejects forbidden identity fields before schema stripping", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "token-1" }));
    const { handler, params } = routeFor("/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ userId: "attacker" }),
      }),
      createEnv(fetch),
      params,
      withSessionRuntime(createEnv(fetch), createContext())
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'userId' is not accepted from verified callers",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GitHub browser attribution availability", () => {
  const subject = "583231";
  let api: ProviderAccountClient;
  let fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
  beforeEach(() => {
    vi.spyOn(UserStore.prototype, "getIdentitiesForUser").mockResolvedValue([
      { provider: "github", providerUserId: subject, providerLogin: null } as never,
    ]);
    vi.spyOn(UserStore.prototype, "getUserById").mockResolvedValue(null);
    api = {
      listUserAccounts: vi.fn(async () => [
        { providerId: "github", accountId: subject, userId: "user-1" },
      ]),
      getAccessToken: vi.fn(async () => ({ accessToken: "grant" })),
      refreshToken: vi.fn(),
      accountInfo: vi.fn(async () => ({
        user: { id: subject },
        data: {
          provider: "github",
          issuer: "https://github.com",
          subject,
          login: "octocat",
          verifiedEmails: [],
          primaryEmail: null,
        },
      })),
    };
    fetch = vi.fn(async () => Response.json({ token: "token-1" }));
  });
  afterEach(() => vi.restoreAllMocks());
  function join(body = {}) {
    const env = { ...createEnv(fetch), SCM_PROVIDER: "github" } as Env;
    const ctx = {
      ...createContext(),
      authentication: {
        mechanism: "browser_session",
        credentialId: "session",
        channel: { kind: "sig1", service: "web" },
      },
      getUserAuth: () => ({ api }),
    } as unknown as RequestContext;
    return handleSessionWsToken(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
      { id: "session-1" },
      withSessionRuntime(env, ctx)
    );
  }
  it.each(["listUserAccounts", "getAccessToken", "accountInfo"] as const)(
    "still mints a WS token when optional %s retrieval fails",
    async (method) => {
      vi.mocked(api[method]).mockRejectedValue(new Error("provider unavailable"));
      expect((await join()).status).toBe(200);
      expect(fetch).toHaveBeenCalledOnce();
      expect(await (fetch.mock.calls[0][0] as Request).json()).not.toHaveProperty(
        "scmUserId",
        subject
      );
    }
  );
  it.each(["listUserAccounts", "getAccessToken", "accountInfo"] as const)(
    "mints a WS token before the proxy deadline when optional %s retrieval stalls",
    async (method) => {
      vi.useFakeTimers();
      try {
        vi.mocked(api[method]).mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error("GitHub request timed out")), 20_000);
            })
        );
        let response: Response | undefined;
        const joined = join().then((value) => {
          response = value;
        });
        await vi.advanceTimersByTimeAsync(14_000);
        const beforeProxyDeadline = response;
        // The delayed rejection must be consumed even if token minting already finished.
        await vi.advanceTimersByTimeAsync(20_000);
        await joined;
        expect(beforeProxyDeadline?.status).toBe(200);
        expect(fetch).toHaveBeenCalledOnce();
        const body = await (fetch.mock.calls[0][0] as Request).json();
        expect(body).toMatchObject({ replaceScmIdentity: true, scmUserId: null, scmLogin: null });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("does not pair a trusted subject with caller display fields when the grant is empty", async () => {
    vi.mocked(api.getAccessToken).mockResolvedValue({ accessToken: "" });
    expect(
      (await join({ scmLogin: "unrelated", scmName: "Caller", scmEmail: "caller@test.local" }))
        .status
    ).toBe(200);
    const body = (await (fetch.mock.calls[0][0] as Request).json()) as Record<string, unknown>;
    expect(body.scmUserId).toBe(subject);
    expect(body.scmLogin ?? null).toBeNull();
    expect(body.scmName ?? null).toBeNull();
    expect(body.scmEmail ?? null).toBeNull();
  });
  it("rejects a mismatched verified profile", async () => {
    vi.mocked(api.accountInfo).mockResolvedValue({
      user: { id: "other" },
      data: {
        provider: "github",
        issuer: "https://github.com",
        subject: "other",
        login: "other",
        verifiedEmails: [],
        primaryEmail: null,
      },
    });
    await expect(join()).rejects.toThrow("mismatched GitHub account");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    new OAuthProviderError("malformed_response", "invalid provider profile"),
    new OAuthProviderError("invalid_configuration", "invalid provider config"),
    new AdmissionDeniedError(),
    APIError.from("BAD_REQUEST", {
      code: "AMBIGUOUS_ACCOUNT",
      message: "Multiple accounts share this ID",
    }),
  ])("rejects provider integrity/admission errors before minting: %s", async (cause) => {
    vi.mocked(api.accountInfo).mockRejectedValue(cause);
    await expect(join()).rejects.toBe(cause);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed authority responses rather than treating them as unavailability", async () => {
    vi.mocked(api.getAccessToken).mockResolvedValue({ accessToken: 123 });
    await expect(join()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
