import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextAuthOptions } from "next-auth";

vi.mock("@open-inspect/shared", () => ({
  DEFAULT_APP_NAME: "Open-Inspect",
}));

vi.mock("next-auth/providers/github", () => ({
  default: (config: unknown) => ({
    id: "github",
    type: "oauth",
    options: config,
  }),
}));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAuthEnv();
});

describe("buildGitHubOAuthScope", () => {
  it("requests base scopes when organization access is disabled", async () => {
    const { BASE_GITHUB_OAUTH_SCOPE, buildGitHubOAuthScope } = await importAuthModule();

    expect(buildGitHubOAuthScope([])).toBe(BASE_GITHUB_OAUTH_SCOPE);
  });

  it("requests read:org only when organization access is configured", async () => {
    const { BASE_GITHUB_OAUTH_SCOPE, buildGitHubOAuthScope } = await importAuthModule();

    expect(buildGitHubOAuthScope(["acme"])).toBe(`${BASE_GITHUB_OAUTH_SCOPE} read:org`);
  });
});

describe("GitHub provider scope", () => {
  it("omits read:org when organization access is disabled", async () => {
    const { authOptions, BASE_GITHUB_OAUTH_SCOPE } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "",
    });

    expect(getGitHubProviderScope(authOptions)).toBe(BASE_GITHUB_OAUTH_SCOPE);
  });

  it("includes read:org when organization access is configured", async () => {
    const { authOptions, BASE_GITHUB_OAUTH_SCOPE } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });

    expect(getGitHubProviderScope(authOptions)).toBe(`${BASE_GITHUB_OAUTH_SCOPE} read:org`);
  });
});

describe("authOptions signIn", () => {
  it("logs static allow decisions without sensitive token data", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_USERS: "alice",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "secret-token" },
        profile: { login: "Alice" },
        user: { email: "alice@example.com" },
      } as never)
    ).resolves.toBe(true);

    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "Alice",
      decision: "allow",
      reason: "username_allowlist",
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-token");
  });

  it("checks configured organization membership with the OAuth access token", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
      NEXT_PUBLIC_APP_NAME: "Test App",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ state: "active" }))
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/acme",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "User-Agent": "Test App",
        }) as HeadersInit,
      })
    );
    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "member",
      decision: "allow",
      reason: "org_membership",
    });
  });

  it("denies organization access when the OAuth access token is missing", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: {},
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[github-org-access] membership check skipped", {
      reason: "missing_access_token",
      organizationCount: 1,
    });
    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "member",
      decision: "deny",
      reason: "org_membership_denied",
    });
  });

  it.each([
    ["404 response", () => new Response("Not Found", { status: 404 })],
    ["pending membership", () => new Response(JSON.stringify({ state: "pending" }))],
  ])("denies organization access for %s", async (_label, responseFactory) => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => responseFactory()) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(false);
  });

  it("does not let unsafe open access bypass configured org allowlists", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
      UNSAFE_ALLOW_ALL_USERS: "true",
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "outsider" },
        user: { email: "outsider@example.com" },
      } as never)
    ).resolves.toBe(false);
  });
});

async function importAuthModule(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  resetAuthEnv();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return import("./auth");
}

function resetAuthEnv(): void {
  for (const key of [
    "ALLOWED_EMAIL_DOMAINS",
    "ALLOWED_USERS",
    "ALLOWED_GITHUB_ORGS",
    "UNSAFE_ALLOW_ALL_USERS",
    "NEXT_PUBLIC_APP_NAME",
  ]) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
}

function getGitHubProviderScope(authOptions: NextAuthOptions): string {
  const provider = authOptions.providers[0] as {
    options: { authorization: { params: { scope: string } } };
  };
  return provider.options.authorization.params.scope;
}

function getSignIn(authOptions: NextAuthOptions) {
  const signIn = authOptions.callbacks?.signIn;
  if (!signIn) {
    throw new Error("signIn callback is not configured");
  }

  return signIn;
}
