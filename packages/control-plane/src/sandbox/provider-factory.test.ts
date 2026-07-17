import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    MEDIA_BUCKET: {} as R2Bucket,
    TOKEN_ENCRYPTION_KEY: "test-token-key",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSandboxProviderFromEnv", () => {
  it("rejects malformed Vercel numeric configuration", () => {
    const env = createEnv({
      VERCEL_TOKEN: "vercel-token",
      VERCEL_PROJECT_ID: "project-id",
      VERCEL_SNAPSHOT_EXPIRATION_MS: "10m",
    });

    expect(() => createSandboxProviderFromEnv(env, "vercel")).toThrow(
      "VERCEL_SNAPSHOT_EXPIRATION_MS must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-stop configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-archive configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "30",
      DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed E2B auto-pause configuration", () => {
    const env = createEnv({
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tmpl",
      E2B_AUTO_PAUSE: "tru",
    });

    expect(() => createSandboxProviderFromEnv(env, "e2b")).toThrow(
      "E2B_AUTO_PAUSE must be a valid boolean"
    );
  });

  it("requires all Superserve endpoints and template settings", () => {
    const env = createEnv({ SUPERSERVE_API_KEY: "superserve-key" });

    expect(() => createSandboxProviderFromEnv(env, "superserve")).toThrow(
      "SUPERSERVE_API_URL, SUPERSERVE_API_KEY, SUPERSERVE_TEMPLATE, and SUPERSERVE_SANDBOX_HOST are required"
    );
  });

  it("rejects malformed Superserve auto-delete configuration", () => {
    const env = createEnv({
      SUPERSERVE_API_URL: "https://api.superserve.test",
      SUPERSERVE_API_KEY: "superserve-key",
      SUPERSERVE_TEMPLATE: "runtime",
      SUPERSERVE_SANDBOX_HOST: "sandbox.superserve.test",
      SUPERSERVE_AUTO_DELETE_SECONDS: "30.5",
    });

    expect(() => createSandboxProviderFromEnv(env, "superserve")).toThrow(
      "SUPERSERVE_AUTO_DELETE_SECONDS must be an integer between 0 and 2592000"
    );
  });

  it("constructs the Superserve provider with optional lifecycle and network policy", () => {
    const env = createEnv({
      SUPERSERVE_API_URL: "https://api.superserve.test",
      SUPERSERVE_API_KEY: "superserve-key",
      SUPERSERVE_TEMPLATE: "runtime",
      SUPERSERVE_SANDBOX_HOST: "sandbox.superserve.test",
      SUPERSERVE_AUTO_DELETE_SECONDS: "604800",
      SUPERSERVE_NETWORK_ALLOW_OUT: "github.com, api.github.com",
      SUPERSERVE_NETWORK_DENY_OUT: "0.0.0.0/0",
    });

    const provider = createSandboxProviderFromEnv(env, "superserve") as unknown as {
      name: string;
      client: { config: Record<string, unknown> };
    };

    expect(provider.name).toBe("superserve");
    expect(provider.client.config).toMatchObject({
      autoDeleteSeconds: 604800,
      network: {
        allowOut: ["github.com", "api.github.com"],
        denyOut: ["0.0.0.0/0"],
      },
    });
  });
});
