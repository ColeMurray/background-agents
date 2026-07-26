import { describe, expect, it, vi } from "vitest";
import {
  OAuthProtocolCallbackRedirectError,
  OAuthProtocolGrantError,
  OAuthProtocolRequestError,
  type OAuthProtocolRuntime,
  OAuthProtocolUnavailableError,
} from "../auth/oauth-runtime";
import type { Env } from "../types";
import {
  createOAuthProtocolRoutes,
  OAuthRateLimitExceededError,
  type OAuthProtocolRateLimiter,
  type OAuthProtocolRouteDependencies,
} from "./oauth";
import type { RequestContext, Route } from "./shared";

const REDIRECT_URI = "https://web.example.com/api/auth/callback";
const STATE = "s".repeat(43);
const CODE_CHALLENGE = "c".repeat(43);
const CORRELATION_FIELDS = {
  request_id: "request-1",
  trace_id: "trace-1",
} as const;
const MISMATCHED_CLIENT_REQUESTS: ReadonlyArray<{
  path: string;
  parameters: Record<string, string>;
}> = [
  {
    path: "/oauth/token",
    parameters: {
      grant_type: "authorization_code",
      code: `oi_code_${"b".repeat(43)}`,
      redirect_uri: REDIRECT_URI,
      client_id: "other",
      code_verifier: "v".repeat(43),
    },
  },
  {
    path: "/oauth/revoke",
    parameters: {
      token: `oi_bsess_${"a".repeat(43)}`,
      client_id: "other",
    },
  },
];

function routeContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db: {} as RequestContext["db"],
    metrics: {} as RequestContext["metrics"],
  };
}

function webServiceContext(): RequestContext {
  return {
    ...routeContext(),
    principal: { kind: "service", service: "web", actor: null },
  };
}

function runtime(overrides: Partial<OAuthProtocolRuntime> = {}): OAuthProtocolRuntime {
  return {
    authorize: vi.fn(),
    completeAuthorization: vi.fn(),
    completeDenial: vi.fn(),
    redeemAuthorizationCode: vi.fn(),
    revokeBrowserSession: vi.fn(),
    ...overrides,
  };
}

function harness(
  options: {
    runtime?: OAuthProtocolRuntime;
    createRuntime?: OAuthProtocolRouteDependencies["createRuntime"];
    requireAllowance?: OAuthProtocolRateLimiter["requireAllowance"];
  } = {}
) {
  const events = { emit: vi.fn() };
  const createRuntime = options.createRuntime ?? vi.fn(() => options.runtime ?? runtime());
  const requireAllowance = options.requireAllowance ?? vi.fn(async () => undefined);
  return {
    routes: createOAuthProtocolRoutes({
      createRuntime,
      rateLimiter: { requireAllowance },
      events,
    }),
    createRuntime,
    requireAllowance,
    events,
  };
}

function findRoute(routes: Route[], method: string, path: string): Route {
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) {
    throw new Error(`Missing ${method} ${path} route`);
  }
  return route;
}

async function dispatch(
  route: Route,
  request: Request,
  context: RequestContext = routeContext()
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const match = path.match(route.pattern);
  if (!match) {
    throw new Error(`Request path ${path} does not match route`);
  }
  return route.handler(request, {} as Env, match, context);
}

function authorizationRequest(overrides: Record<string, string> = {}): Request {
  const url = new URL("https://cp.example.com/oauth/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "web",
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: STATE,
    provider: "github",
    ...overrides,
  }).toString();
  return new Request(url);
}

function formRequest(
  path: string,
  parameters: Record<string, string>,
  contentType = "application/x-www-form-urlencoded; charset=UTF-8"
): Request {
  return new Request(`https://cp.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new URLSearchParams(parameters),
  });
}

describe("OAuth protocol routes", () => {
  it("returns a hardened provider redirect for a valid authorization request", async () => {
    const authorize = vi.fn(async () => new URL("https://github.com/login/oauth/authorize"));
    const { routes, events } = harness({ runtime: runtime({ authorize }) });
    const route = findRoute(routes, "GET", "/oauth/authorize");

    const response = await dispatch(route, authorizationRequest());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/login/oauth/authorize");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(authorize).toHaveBeenCalledWith({
      responseType: "code",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      state: STATE,
      provider: "github",
    });
    expect(events.emit).toHaveBeenCalledWith("auth.oauth.authorize_started", {
      client_id: "web",
      provider: "github",
      ...CORRELATION_FIELDS,
    });
  });

  it("rate-limits then rejects duplicate authorization parameters before runtime work", async () => {
    const createRuntime = vi.fn();
    const requireAllowance = vi.fn();
    const { routes } = harness({ createRuntime, requireAllowance });
    const route = findRoute(routes, "GET", "/oauth/authorize");
    const requestUrl = new URL("https://cp.example.com/oauth/authorize");
    requestUrl.search = new URLSearchParams([
      ["response_type", "code"],
      ["client_id", "web"],
      ["client_id", "other"],
      ["redirect_uri", REDIRECT_URI],
      ["code_challenge", CODE_CHALLENGE],
      ["code_challenge_method", "S256"],
      ["state", STATE],
      ["provider", "github"],
    ]).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(requireAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ routeClass: "authorize", clientId: "web" })
    );
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("redeems an authorization code for the authenticated web service", async () => {
    const accessToken = `oi_bsess_${"a".repeat(43)}`;
    const redeemAuthorizationCode = vi.fn(async () => ({
      accessToken,
      expiresIn: 30 * 24 * 60 * 60,
      idleExpiresIn: 7 * 24 * 60 * 60,
    }));
    const { routes, events } = harness({
      runtime: runtime({ redeemAuthorizationCode }),
    });
    const route = findRoute(routes, "POST", "/oauth/token");

    const response = await dispatch(
      route,
      formRequest("/oauth/token", {
        grant_type: "authorization_code",
        code: `oi_code_${"b".repeat(43)}`,
        redirect_uri: REDIRECT_URI,
        client_id: "web",
        code_verifier: "v".repeat(43),
      }),
      webServiceContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      idle_expires_in: 7 * 24 * 60 * 60,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(redeemAuthorizationCode).toHaveBeenCalledWith({
      code: `oi_code_${"b".repeat(43)}`,
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeVerifier: "v".repeat(43),
    });
    expect(events.emit).toHaveBeenCalledWith("auth.oauth.code_redeemed", {
      client_id: "web",
      ...CORRELATION_FIELDS,
    });
    expect(events.emit).toHaveBeenCalledWith("auth.browser_session.created", {
      client_id: "web",
      ...CORRELATION_FIELDS,
    });
  });

  it("rejects token redemption without a web service principal before parsing", async () => {
    const createRuntime = vi.fn();
    const requireAllowance = vi.fn();
    const { routes } = harness({ createRuntime, requireAllowance });
    const route = findRoute(routes, "POST", "/oauth/token");

    const response = await dispatch(
      route,
      new Request("https://cp.example.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(requireAllowance).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each(MISMATCHED_CLIENT_REQUESTS)(
    "rejects a mismatched client_id on $path",
    async ({ path, parameters }) => {
      const createRuntime = vi.fn();
      const { routes, requireAllowance } = harness({ createRuntime });
      const route = findRoute(routes, "POST", path);

      const response = await dispatch(route, formRequest(path, parameters), webServiceContext());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
      expect(requireAllowance).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "unknown" })
      );
      expect(createRuntime).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: "non-form content",
      request: () =>
        new Request("https://cp.example.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      status: 415,
    },
    {
      name: "duplicate form keys",
      request: () =>
        new Request("https://cp.example.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "client_id=web&client_id=other",
        }),
      status: 400,
    },
    {
      name: "malformed percent-encoded form input",
      request: () =>
        new Request("https://cp.example.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "client_id=web&code=%FF",
        }),
      status: 400,
    },
    {
      name: "an oversized form",
      request: () =>
        formRequest("/oauth/token", {
          client_id: "web",
          code: "x".repeat(16 * 1024),
        }),
      status: 413,
    },
  ])("rejects $name before runtime work", async ({ request, status }) => {
    const createRuntime = vi.fn();
    const requireAllowance = vi.fn();
    const { routes } = harness({ createRuntime, requireAllowance });
    const route = findRoute(routes, "POST", "/oauth/token");

    const response = await dispatch(route, request(), webServiceContext());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requireAllowance).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("completes a provider callback and redirects to the registered web client", async () => {
    const completeAuthorization = vi.fn(async () => {
      const redirect = new URL(REDIRECT_URI);
      redirect.searchParams.set("code", `oi_code_${"a".repeat(43)}`);
      redirect.searchParams.set("state", STATE);
      return redirect;
    });
    const { routes, events } = harness({
      runtime: runtime({ completeAuthorization }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/github");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/github");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      code: "provider-code",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?code=oi_code_${"a".repeat(43)}&state=${STATE}`
    );
    expect(completeAuthorization).toHaveBeenCalledWith("github", {
      state: STATE,
      code: "provider-code",
    });
    expect(events.emit).toHaveBeenCalledWith("auth.oauth.provider_callback_succeeded", {
      client_id: "web",
      provider: "github",
      ...CORRELATION_FIELDS,
    });
  });

  it("rejects an unknown callback provider without runtime work", async () => {
    const createRuntime = vi.fn();
    const { routes } = harness({ createRuntime });
    const route = findRoute(routes, "GET", "/oauth/callback/oidc");

    const response = await dispatch(
      route,
      new Request(`https://cp.example.com/oauth/callback/oidc?state=${STATE}&code=provider-code`)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoded callback input before runtime work", async () => {
    const createRuntime = vi.fn();
    const { routes } = harness({ createRuntime });
    const route = findRoute(routes, "GET", "/oauth/callback/github");
    const request = new Request(
      `https://cp.example.com/oauth/callback/github?state=${STATE}&code=%FF`
    );

    const response = await dispatch(route, request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("consumes a provider denial and returns a bounded client error redirect", async () => {
    const completeDenial = vi.fn(async () => {
      const redirect = new URL(REDIRECT_URI);
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", STATE);
      return redirect;
    });
    const { routes, events } = harness({
      runtime: runtime({ completeDenial }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/google");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/google");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      error: "user_cancelled",
      error_description: "provider details must not be reflected",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?error=access_denied&state=${STATE}`
    );
    expect(completeDenial).toHaveBeenCalledWith("google", STATE);
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.provider_callback_rejected",
      {
        client_id: "web",
        provider: "google",
        failure: "provider_denied",
        ...CORRELATION_FIELDS,
      },
      "warn"
    );
  });

  it("maps a trusted callback failure to the registered redirect without leaking details", async () => {
    const completeAuthorization = vi.fn(async () => {
      throw new OAuthProtocolCallbackRedirectError("account_link_required", REDIRECT_URI);
    });
    const { routes, events } = harness({
      runtime: runtime({ completeAuthorization }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/github");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/github");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      code: "provider-code",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?error=account_link_required&state=${STATE}`
    );
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.provider_callback_rejected",
      {
        client_id: "web",
        provider: "github",
        failure: "account_link_required",
        ...CORRELATION_FIELDS,
      },
      "warn"
    );
  });

  it("revokes a browser credential without exposing whether it existed", async () => {
    const token = `oi_bsess_${"a".repeat(43)}`;
    const revokeBrowserSession = vi.fn(async () => false);
    const { routes, events } = harness({
      runtime: runtime({ revokeBrowserSession }),
    });
    const route = findRoute(routes, "POST", "/oauth/revoke");

    const response = await dispatch(
      route,
      formRequest("/oauth/revoke", {
        token,
        token_type_hint: "access_token",
        client_id: "web",
      }),
      webServiceContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(revokeBrowserSession).toHaveBeenCalledWith(token);
    expect(events.emit).toHaveBeenCalledWith("auth.browser_session.revoked", {
      client_id: "web",
      outcome: "already_absent",
      reason: "logout",
      ...CORRELATION_FIELDS,
    });
  });

  it("rejects an unsupported revocation token type before runtime work", async () => {
    const createRuntime = vi.fn();
    const { routes } = harness({ createRuntime });
    const route = findRoute(routes, "POST", "/oauth/revoke");

    const response = await dispatch(
      route,
      formRequest("/oauth/revoke", {
        token: `oi_bsess_${"a".repeat(43)}`,
        token_type_hint: "refresh_token",
        client_id: "web",
      }),
      webServiceContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_token_type" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("returns retry guidance when the OAuth request limit is exhausted", async () => {
    const createRuntime = vi.fn();
    const { routes } = harness({
      createRuntime,
      requireAllowance: vi.fn(async () => {
        throw new OAuthRateLimitExceededError(60);
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/authorize");

    const response = await dispatch(route, authorizationRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("returns a bounded authorization error without redirecting an unknown client", async () => {
    const { routes, requireAllowance } = harness({
      runtime: runtime({
        authorize: vi.fn(async () => {
          throw new OAuthProtocolRequestError("invalid_client");
        }),
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/authorize");

    const response = await dispatch(
      route,
      authorizationRequest({
        client_id: "attacker-controlled-client",
        redirect_uri: "https://attacker.example.com/callback",
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(requireAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ routeClass: "authorize", clientId: "unknown" })
    );
  });

  it("maps authorization-code rejection to invalid_grant telemetry", async () => {
    const { routes, events } = harness({
      runtime: runtime({
        redeemAuthorizationCode: vi.fn(async () => {
          throw new OAuthProtocolGrantError("already_consumed");
        }),
      }),
    });
    const route = findRoute(routes, "POST", "/oauth/token");

    const response = await dispatch(
      route,
      formRequest("/oauth/token", {
        grant_type: "authorization_code",
        code: `oi_code_${"b".repeat(43)}`,
        redirect_uri: REDIRECT_URI,
        client_id: "web",
        code_verifier: "v".repeat(43),
      }),
      webServiceContext()
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.code_rejected",
      {
        client_id: "web",
        failure: "already_consumed",
        ...CORRELATION_FIELDS,
      },
      "warn"
    );
  });

  it("fails closed when the OAuth runtime is not configured", async () => {
    const { routes } = harness({
      createRuntime: vi.fn(() => {
        throw new OAuthProtocolUnavailableError("OAUTH_WEB_REDIRECT_URIS");
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/authorize");

    const response = await dispatch(route, authorizationRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
  });

  it("rejects an unknown provider callback state without redirecting", async () => {
    const { routes } = harness({
      runtime: runtime({
        completeAuthorization: vi.fn(async () => {
          throw new OAuthProtocolRequestError("invalid_request");
        }),
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/github");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/github");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      code: "provider-code",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects a callback whose consumed flow is not bound to the web client", async () => {
    const { routes } = harness({
      runtime: runtime({
        completeAuthorization: vi.fn(async () => {
          throw new OAuthProtocolRequestError("invalid_request");
        }),
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/github");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/github");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      code: "provider-code",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects a callback for a disabled provider without exposing configuration", async () => {
    const { routes } = harness({
      runtime: runtime({
        completeAuthorization: vi.fn(async () => {
          throw new OAuthProtocolRequestError("invalid_request");
        }),
      }),
    });
    const route = findRoute(routes, "GET", "/oauth/callback/google");
    const requestUrl = new URL("https://cp.example.com/oauth/callback/google");
    requestUrl.search = new URLSearchParams({
      state: STATE,
      code: "provider-code",
    }).toString();

    const response = await dispatch(route, new Request(requestUrl));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});
