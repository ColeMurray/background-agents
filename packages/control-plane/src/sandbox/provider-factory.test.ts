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

  it("rejects malformed Islo start command JSON with a named env error", () => {
    const env = createEnv({
      ISLO_API_KEY: "islo-key",
      ISLO_START_COMMAND: "[not-json",
    });

    expect(() => createSandboxProviderFromEnv(env, "islo")).toThrow(
      "ISLO_START_COMMAND must be valid JSON"
    );
  });

  it("accepts Islo without a base snapshot by falling back to a base image", () => {
    const env = createEnv({
      ISLO_API_KEY: "islo-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "islo")).not.toThrow();
  });

  it("rejects malformed Islo lifecycle configuration", () => {
    const env = createEnv({
      ISLO_API_KEY: "islo-key",
      ISLO_LIFECYCLE_PAUSE_AFTER_IDLE_SECONDS: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "islo")).toThrow(
      "ISLO_LIFECYCLE_PAUSE_AFTER_IDLE_SECONDS must be a positive integer"
    );
  });
});
