import { afterEach, describe, expect, it, vi } from "vitest";

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

import { authOptions, BASE_GITHUB_OAUTH_SCOPE, buildGitHubOAuthScope } from "./auth";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [
    "ALLOWED_EMAIL_DOMAINS",
    "ALLOWED_USERS",
    "ALLOWED_GITHUB_ORGS",
    "UNSAFE_ALLOW_ALL_USERS",
  ]) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
});

describe("buildGitHubOAuthScope", () => {
  it("requests base scopes when organization access is disabled", () => {
    expect(buildGitHubOAuthScope([])).toBe(BASE_GITHUB_OAUTH_SCOPE);
  });

  it("requests read:org only when organization access is configured", () => {
    expect(buildGitHubOAuthScope(["acme"])).toBe(`${BASE_GITHUB_OAUTH_SCOPE} read:org`);
  });
});

describe("authOptions signIn", () => {
  it("logs static allow decisions without sensitive token data", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "";
    process.env.ALLOWED_USERS = "alice";
    process.env.ALLOWED_GITHUB_ORGS = "";
    process.env.UNSAFE_ALLOW_ALL_USERS = "";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const signIn = authOptions.callbacks?.signIn;

    await expect(
      signIn?.({
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
});
