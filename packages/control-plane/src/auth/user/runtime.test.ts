import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUserAuthFromEnv,
  createUserAuthRuntimeFromEnv,
  getUserAuthRuntime,
  parsePublicWebOrigin,
} from "./runtime";
import { createUserAuth } from "./better-auth";
import type { Env } from "../../types";

// Constructing the real Better Auth instance would initialize a D1 adapter, so the
// provider-resolution tests below assert the config it is handed instead.
vi.mock("./better-auth", () => ({ createUserAuth: vi.fn(() => ({}) as never) }));

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

describe("createUserAuthFromEnv sign-in provider configuration", () => {
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
    createUserAuthFromEnv(
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
    expect(() => createUserAuthFromEnv(envWith({}), STUB_DATABASE)).toThrow(
      /At least one sign-in provider must be configured/
    );
  });

  it.each([
    ["GITHUB_CLIENT_ID", { GITHUB_CLIENT_ID: "github-id" }],
    ["GITHUB_CLIENT_SECRET", { GITHUB_CLIENT_SECRET: "github-secret" }],
  ])("rejects a half-configured GitHub provider: %s alone", (_name, overrides) => {
    expect(() => createUserAuthFromEnv(envWith(overrides), STUB_DATABASE)).toThrow(
      /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together/
    );
  });

  it.each([
    ["GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: "google-id" }],
    ["GOOGLE_CLIENT_SECRET", { GOOGLE_CLIENT_SECRET: "google-secret" }],
  ])("rejects a half-configured Google provider: %s alone", (_name, overrides) => {
    expect(() => createUserAuthFromEnv(envWith(overrides), STUB_DATABASE)).toThrow(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together/
    );
  });

  it("treats whitespace-only credentials as unset", () => {
    expect(() =>
      createUserAuthFromEnv(
        envWith({ GITHUB_CLIENT_ID: "   ", GITHUB_CLIENT_SECRET: "   " }),
        STUB_DATABASE
      )
    ).toThrow(/At least one sign-in provider must be configured/);
  });
});
