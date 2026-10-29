import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdmissionRules, type AdmissionRules } from "@open-inspect/shared/admission-settings";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { createUserAuthRuntimeFromEnv, getUserAuthRuntime, parsePublicWebOrigin } from "./runtime";
import { createUserAuth } from "./better-auth";
import type { Env } from "../../types";
import { AdmissionPolicyStore } from "../../db/admission-policy-store";
import { IdentityClaimStore } from "../../db/identity-claim-store";
import { GitHubProviderIdentityResolver } from "./providers/github-identity";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";

// Constructing the real Better Auth instance would initialize a D1 adapter, so the
// provider-resolution tests below assert the config it is handed instead.
vi.mock("./better-auth", () => ({ createUserAuth: vi.fn(() => ({}) as never) }));
vi.mock("better-auth/social-providers", () => ({ verifyGoogleIdToken: vi.fn() }));

const BASE_ENV = {
  WEB_APP_URL: "https://open-inspect.example",
  BROWSER_AUTH_SECRET: "x".repeat(32),
  ALLOWED_EMAILS: "allowed@example.com",
} as const;

function envWith(overrides: Record<string, string>): Env {
  return { ...BASE_ENV, ...overrides } as unknown as Env;
}

const STUB_DATABASE = {} as D1Database;

function configuredProviders(): string[] {
  const config = vi.mocked(createUserAuth).mock.calls.at(-1)?.[0] ?? {};
  return ["github", "google"].filter((provider) => provider in config);
}

describe("parsePublicWebOrigin", () => {
  it.each([
    ["https://open-inspect.example", "https://open-inspect.example"],
    ["https://open-inspect.example/", "https://open-inspect.example"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("accepts a browser-reachable web origin: %s", (configured, expected) => {
    expect(parsePublicWebOrigin(configured)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://open-inspect.example",
    "http://localhost.evil.example:3000",
    "https://open-inspect.example/path",
    "https://open-inspect.example?query=1",
  ])("rejects an unsafe or non-origin WEB_APP_URL: %s", (configured) => {
    expect(() => parsePublicWebOrigin(configured)).toThrow();
  });
});

describe("createUserAuthRuntimeFromEnv sign-in provider configuration", () => {
  beforeEach(() => {
    vi.mocked(createUserAuth).mockClear();
  });

  it("accepts a Google-only deployment and wires only Google", () => {
    const runtime = createUserAuthRuntimeFromEnv(
      envWith({ GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-secret" }),
      STUB_DATABASE
    );
    expect(configuredProviders()).toEqual(["google"]);
    expect(runtime.enabledProviders).toEqual(configuredProviders());
  });

  it("accepts a GitHub-only deployment and wires only GitHub", () => {
    const runtime = createUserAuthRuntimeFromEnv(
      envWith({ GITHUB_CLIENT_ID: "github-id", GITHUB_CLIENT_SECRET: "github-secret" }),
      STUB_DATABASE
    );
    expect(configuredProviders()).toEqual(["github"]);
    expect(runtime.enabledProviders).toEqual(configuredProviders());
  });

  it("wires both providers when both are configured", () => {
    createUserAuthRuntimeFromEnv(
      envWith({
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
      }),
      STUB_DATABASE
    );
    expect(configuredProviders()).toEqual(["github", "google"]);
  });

  it("reports the same providers used to construct Better Auth", () => {
    const runtime = createUserAuthRuntimeFromEnv(
      envWith({
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
      }),
      STUB_DATABASE
    );

    expect(runtime.enabledProviders).toEqual(["github", "google"]);
    expect(configuredProviders()).toEqual(runtime.enabledProviders);
  });

  it.each([
    ["WEB_APP_URL", { WEB_APP_URL: "https://other.example" }],
    ["BROWSER_AUTH_SECRET", { BROWSER_AUTH_SECRET: "y".repeat(32) }],
    ["APP_NAME", { APP_NAME: "Other Name" }],
    ["GITHUB_CLIENT_ID", { GITHUB_CLIENT_ID: "other-github-id" }],
    ["GITHUB_CLIENT_SECRET", { GITHUB_CLIENT_SECRET: "other-github-secret" }],
    ["GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: "other-google-id" }],
    ["GOOGLE_CLIENT_SECRET", { GOOGLE_CLIENT_SECRET: "other-google-secret" }],
    ["ALLOWED_USERS", { ALLOWED_USERS: "other-user" }],
    ["ALLOWED_EMAILS", { ALLOWED_EMAILS: "other@example.com" }],
    ["ALLOWED_EMAIL_DOMAINS", { ALLOWED_EMAIL_DOMAINS: "other.example" }],
    ["ALLOWED_GITHUB_ORGS", { ALLOWED_GITHUB_ORGS: "other-org" }],
    ["UNSAFE_ALLOW_ALL_USERS", { UNSAFE_ALLOW_ALL_USERS: "true" }],
  ])("invalidates the cached runtime when %s changes", (_name, override) => {
    const database = {} as D1Database;
    const configuredEnv = envWith({
      APP_NAME: "Open Inspect",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
    });

    const first = getUserAuthRuntime(configuredEnv, database);
    const second = getUserAuthRuntime({ ...configuredEnv, ...override }, database);

    expect(second).not.toBe(first);
  });

  it("rejects Google when admission is GitHub-specific", () => {
    expect(() =>
      createUserAuthRuntimeFromEnv(
        envWith({
          ALLOWED_EMAILS: "",
          ALLOWED_USERS: "octocat",
          GOOGLE_CLIENT_ID: "google-id",
          GOOGLE_CLIENT_SECRET: "google-secret",
        }),
        STUB_DATABASE
      )
    ).toThrow(/Google sign-in requires provider-neutral admission/);
  });

  it("rejects a provider with no admission path", () => {
    expect(() =>
      createUserAuthRuntimeFromEnv(
        envWith({
          ALLOWED_EMAILS: "",
          GITHUB_CLIENT_ID: "github-id",
          GITHUB_CLIENT_SECRET: "github-secret",
        }),
        STUB_DATABASE
      )
    ).toThrow(/GitHub sign-in has no compatible admission policy/);
  });

  it("rejects a deployment with no sign-in provider configured", () => {
    expect(() => createUserAuthRuntimeFromEnv(envWith({}), STUB_DATABASE)).toThrow(
      /At least one sign-in provider must be configured/
    );
  });

  it.each([
    ["GITHUB_CLIENT_ID", { GITHUB_CLIENT_ID: "github-id" }],
    ["GITHUB_CLIENT_SECRET", { GITHUB_CLIENT_SECRET: "github-secret" }],
  ])("rejects a half-configured GitHub provider: %s alone", (_name, overrides) => {
    expect(() => createUserAuthRuntimeFromEnv(envWith(overrides), STUB_DATABASE)).toThrow(
      /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together/
    );
  });

  it.each([
    ["GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: "google-id" }],
    ["GOOGLE_CLIENT_SECRET", { GOOGLE_CLIENT_SECRET: "google-secret" }],
  ])("rejects a half-configured Google provider: %s alone", (_name, overrides) => {
    expect(() => createUserAuthRuntimeFromEnv(envWith(overrides), STUB_DATABASE)).toThrow(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together/
    );
  });

  it("treats whitespace-only credentials as unset", () => {
    expect(() =>
      createUserAuthRuntimeFromEnv(
        envWith({ GITHUB_CLIENT_ID: "   ", GITHUB_CLIENT_SECRET: "   " }),
        STUB_DATABASE
      )
    ).toThrow(/At least one sign-in provider must be configured/);
  });
});

describe("runtime-managed admission", () => {
  let rules: AdmissionRules;
  const githubEnv = envWith({
    GITHUB_CLIENT_ID: "github-id",
    GITHUB_CLIENT_SECRET: "github-secret",
  });
  const tokens = { accessToken: "github-token" };

  beforeEach(() => {
    vi.mocked(createUserAuth).mockClear();
    rules = emptyAdmissionRules();
    vi.spyOn(AdmissionPolicyStore.prototype, "get").mockImplementation(async () => ({
      rules,
      rulesJson: JSON.stringify(rules),
      revision: 1,
      updatedAt: null,
      updatedByUserId: null,
    }));
    vi.spyOn(GitHubProviderIdentityResolver.prototype, "resolveIdentity").mockResolvedValue({
      provider: "github",
      issuer: "https://github.com",
      subject: "123",
      login: "octocat",
      verifiedEmails: ["primary@example.net", "secondary@corp.example"],
      primaryEmail: "primary@example.net",
    });
    vi.spyOn(IdentityClaimStore.prototype, "findIdentityOwnerId").mockResolvedValue(
      "existing-user"
    );
    vi.spyOn(IdentityClaimStore.prototype, "getEmailState").mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function githubResolver() {
    return vi.mocked(createUserAuth).mock.calls.at(-1)![0].github!.getUserInfo;
  }

  it("reads additions and removals on the same cached runtime and an independent runtime", async () => {
    const database = {} as D1Database;
    const cached = getUserAuthRuntime(githubEnv, database);
    const first = githubResolver();
    createUserAuthRuntimeFromEnv(githubEnv, {} as D1Database);
    const second = githubResolver();
    expect(AdmissionPolicyStore.prototype.get).not.toHaveBeenCalled();

    for (const resolver of [first, second]) {
      await expect(resolver(tokens)).rejects.toBeInstanceOf(AdmissionDeniedError);
    }
    rules = { ...emptyAdmissionRules(), allowedGitHubUsers: ["octocat"] };
    expect(getUserAuthRuntime(githubEnv, database)).toBe(cached);
    for (const resolver of [first, second]) {
      await expect(resolver(tokens)).resolves.toMatchObject({ data: { subject: "123" } });
    }
    rules = emptyAdmissionRules();
    for (const resolver of [first, second]) {
      await expect(resolver(tokens)).rejects.toBeInstanceOf(AdmissionDeniedError);
    }
    expect(createUserAuth).toHaveBeenCalledTimes(2);
    expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledTimes(6);
    expect(IdentityClaimStore.prototype.findIdentityOwnerId).toHaveBeenCalledTimes(2);
  });

  it.each([
    { allowedGitHubUsers: [" OCTOCAT "] },
    { allowedEmails: ["SECONDARY@corp.example"] },
    { allowedEmailDomains: ["CORP.EXAMPLE"] },
    { allowedGitHubOrganizations: ["Example-Org"] },
  ])("uses managed rules additively for verified GitHub evidence: %j", async (managed) => {
    rules = { ...emptyAdmissionRules(), ...managed };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "active" }))
    );
    createUserAuthRuntimeFromEnv(githubEnv, STUB_DATABASE);
    await expect(githubResolver()(tokens)).resolves.toMatchObject({
      user: { email: "primary@example.net" },
    });
    expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledOnce();
  });

  it("retains a deployment grant when its managed duplicate is removed", async () => {
    rules = { ...emptyAdmissionRules(), allowedGitHubUsers: ["octocat"] };
    createUserAuthRuntimeFromEnv({ ...githubEnv, ALLOWED_USERS: "octocat" }, STUB_DATABASE);
    const resolver = githubResolver();
    await expect(resolver(tokens)).resolves.toBeDefined();
    rules = emptyAdmissionRules();
    await expect(resolver(tokens)).resolves.toBeDefined();
    expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledTimes(2);
  });

  it.each([{ ALLOWED_USERS: "octocat" }, { ALLOWED_EMAILS: "", UNSAFE_ALLOW_ALL_USERS: "true" }])(
    "does not bypass an unavailable store for deployment admission: %j",
    async (baseline) => {
      createUserAuthRuntimeFromEnv({ ...githubEnv, ...baseline }, STUB_DATABASE);
      const resolver = githubResolver();
      await expect(resolver(tokens)).resolves.toBeDefined();
      vi.mocked(IdentityClaimStore.prototype.findIdentityOwnerId).mockClear();
      vi.mocked(AdmissionPolicyStore.prototype.get).mockRejectedValue(
        new Error("sensitive database detail")
      );
      await expect(resolver(tokens)).rejects.toBeInstanceOf(AdmissionUnavailableError);
      expect(IdentityClaimStore.prototype.findIdentityOwnerId).not.toHaveBeenCalled();
      expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledTimes(2);
    }
  );

  it("does not let unsafe mode override a nonempty managed policy", async () => {
    createUserAuthRuntimeFromEnv(
      { ...githubEnv, ALLOWED_EMAILS: "", UNSAFE_ALLOW_ALL_USERS: "true" },
      STUB_DATABASE
    );
    const resolver = githubResolver();
    await expect(resolver(tokens)).resolves.toBeDefined();
    rules = { ...emptyAdmissionRules(), allowedGitHubUsers: ["someone-else"] };
    await expect(resolver(tokens)).rejects.toBeInstanceOf(AdmissionDeniedError);
  });

  it.each([
    ["missing singleton", null],
    ["invalid JSON", { schema_version: 1, rules_json: "not-json" }],
    [
      "unsupported schema",
      { schema_version: 2, rules_json: JSON.stringify(emptyAdmissionRules()) },
    ],
    ["database failure", new Error("no such table: workspace_admission_policy")],
  ] as const)("translates a real store's %s failure before any claim", async (_name, value) => {
    vi.mocked(AdmissionPolicyStore.prototype.get).mockRestore();
    const row =
      value === null || value instanceof Error
        ? value
        : {
            revision: 0,
            updated_at: null,
            updated_by_user_id_snapshot: null,
            ...value,
          };
    const first =
      row instanceof Error ? vi.fn().mockRejectedValue(row) : vi.fn().mockResolvedValue(row);
    const database = { prepare: vi.fn(() => ({ first })) } as unknown as D1Database;
    createUserAuthRuntimeFromEnv({ ...githubEnv, ALLOWED_USERS: "octocat" }, database);
    await expect(githubResolver()(tokens)).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(first).toHaveBeenCalledOnce();
    expect(IdentityClaimStore.prototype.findIdentityOwnerId).not.toHaveBeenCalled();
  });

  it("does not let managed rules bypass the static provider compatibility check", () => {
    rules = { ...emptyAdmissionRules(), allowedEmails: ["allowed@example.com"] };
    expect(() =>
      createUserAuthRuntimeFromEnv(
        envWith({
          ALLOWED_EMAILS: "",
          ALLOWED_USERS: "octocat",
          GOOGLE_CLIENT_ID: "id",
          GOOGLE_CLIENT_SECRET: "secret",
        }),
        STUB_DATABASE
      )
    ).toThrow(/Google sign-in requires provider-neutral admission/);
    expect(AdmissionPolicyStore.prototype.get).not.toHaveBeenCalled();
  });

  it("reads Google rules dynamically while preserving exact-domain and provider boundaries", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      email: "member@corp.example",
      email_verified: true,
    });
    createUserAuthRuntimeFromEnv(
      envWith({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
      STUB_DATABASE
    );
    const resolver = vi.mocked(createUserAuth).mock.calls.at(-1)![0].google!.getUserInfo;
    for (const managed of [
      { allowedGitHubUsers: ["google-subject"] },
      { allowedGitHubOrganizations: ["corp"] },
      { allowedEmailDomains: ["example"] },
    ]) {
      rules = { ...emptyAdmissionRules(), ...managed };
      await expect(resolver({ idToken: "google-token" })).rejects.toBeInstanceOf(
        AdmissionDeniedError
      );
    }
    rules = { ...emptyAdmissionRules(), allowedEmailDomains: ["corp.example"] };
    await expect(resolver({ idToken: "google-token" })).resolves.toMatchObject({
      data: { subject: "google-subject" },
    });
    expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledTimes(4);
  });

  it("lets an in-flight evaluation finish against its read snapshot without caching it", async () => {
    let finishMembership!: (response: Response) => void;
    let membershipStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      membershipStarted = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMembership = resolve;
          membershipStarted();
        })
    );
    vi.stubGlobal("fetch", fetcher);
    rules = { ...emptyAdmissionRules(), allowedGitHubOrganizations: ["old-org"] };
    createUserAuthRuntimeFromEnv(githubEnv, STUB_DATABASE);
    const resolver = githubResolver();
    const inFlight = resolver(tokens);
    await started;
    rules = emptyAdmissionRules();
    await expect(resolver(tokens)).rejects.toBeInstanceOf(AdmissionDeniedError);
    finishMembership(Response.json({ state: "active" }));
    await expect(inFlight).resolves.toBeDefined();
    expect(AdmissionPolicyStore.prototype.get).toHaveBeenCalledTimes(2);
  });
});
