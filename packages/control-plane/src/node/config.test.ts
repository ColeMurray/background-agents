import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, readEnvConfig, readNodeHostSettings } from "./config";

const REQUIRED = {
  DEPLOYMENT_NAME: "test",
  GITHUB_BOT_USERNAME: "bot[bot]",
  TOKEN_ENCRYPTION_KEY: "k1",
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "k2",
};

describe("readEnvConfig", () => {
  it("takes every EnvConfig field from the source and nothing else", () => {
    const config = readEnvConfig({
      ...REQUIRED,
      LOG_LEVEL: "debug",
      SANDBOX_PROVIDER: "e2b",
      PATH: "/usr/bin",
      DATA_DIR: "/var/lib/oi",
    });
    expect(config).toEqual({ ...REQUIRED, LOG_LEVEL: "debug", SANDBOX_PROVIDER: "e2b" });
  });

  it("treats an empty variable as unset", () => {
    const config = readEnvConfig({ ...REQUIRED, LOG_LEVEL: "" });
    expect("LOG_LEVEL" in config).toBe(false);
  });

  it("names every missing required variable at once", () => {
    expect(() => readEnvConfig({ DEPLOYMENT_NAME: "test", TOKEN_ENCRYPTION_KEY: "" })).toThrow(
      "Missing required configuration: GITHUB_BOT_USERNAME, TOKEN_ENCRYPTION_KEY, PROVIDER_ACCOUNTS_ENCRYPTION_KEY"
    );
  });
});

describe("readNodeHostSettings", () => {
  it("requires DATA_DIR and defaults the rest", () => {
    expect(() => readNodeHostSettings({})).toThrow("DATA_DIR is required");
    const settings = readNodeHostSettings({ DATA_DIR: "/var/lib/oi" });
    expect(settings).toEqual({
      host: "0.0.0.0",
      port: 8787,
      dataDir: "/var/lib/oi",
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      shutdownTimeoutMs: 30_000,
    });
    expect(DEFAULT_MIGRATIONS_DIR.endsWith("/terraform/d1/migrations")).toBe(true);
  });

  it("reads the overrides and rejects a malformed number", () => {
    const settings = readNodeHostSettings({
      DATA_DIR: "data",
      HOST: "127.0.0.1",
      PORT: "9000",
      MIGRATIONS_DIR: "/srv/migrations",
      SHUTDOWN_TIMEOUT_MS: "5000",
    });
    expect(settings.host).toBe("127.0.0.1");
    expect(settings.port).toBe(9000);
    expect(settings.dataDir).toBe(`${process.cwd()}/data`);
    expect(settings.migrationsDir).toBe("/srv/migrations");
    expect(settings.shutdownTimeoutMs).toBe(5000);
    expect(() => readNodeHostSettings({ DATA_DIR: "data", PORT: "80a" })).toThrow(
      "PORT must be a non-negative integer, got 80a"
    );
  });
});
