import { describe, expect, it } from "vitest";
import { SourceControlProviderError } from "./errors";
import {
  DEFAULT_SCM_PROVIDER,
  getSourceControlProviderFactoryConfig,
  resolveScmProvider,
  resolveScmProviderFromEnv,
} from "./config";

describe("resolveScmProviderFromEnv", () => {
  it("defaults to github when SCM_PROVIDER is unset", () => {
    expect(resolveScmProviderFromEnv(undefined)).toBe(DEFAULT_SCM_PROVIDER);
  });

  it("normalizes case and whitespace", () => {
    expect(resolveScmProviderFromEnv("  GITHUB ")).toBe("github");
    expect(resolveScmProviderFromEnv(" bitbucket ")).toBe("bitbucket");
  });

  it("throws for unknown provider values", () => {
    expect(() => resolveScmProviderFromEnv("gitlab")).toThrow(SourceControlProviderError);
    expect(() => resolveScmProviderFromEnv("gitlab")).toThrow(
      "Invalid SCM_PROVIDER value 'gitlab'"
    );
  });
});

describe("resolveScmProvider", () => {
  it("infers bitbucket when SCM_PROVIDER is unset and bitbucket env is present", () => {
    expect(
      resolveScmProvider({
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_CLIENT_ID: "client-id",
      })
    ).toBe("bitbucket");
  });

  it("keeps explicit SCM_PROVIDER precedence over inferred config", () => {
    expect(
      resolveScmProvider({
        SCM_PROVIDER: "github",
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_CLIENT_ID: "client-id",
      })
    ).toBe("github");
  });
});

describe("getSourceControlProviderFactoryConfig", () => {
  it("builds a shared provider config from worker env", () => {
    const config = getSourceControlProviderFactoryConfig({
      SCM_PROVIDER: "bitbucket",
      REPOS_CACHE: {} as KVNamespace,
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_CLIENT_ID: "client-id",
      BITBUCKET_CLIENT_SECRET: "client-secret",
      BITBUCKET_BOT_USERNAME: "bot-user",
      BITBUCKET_BOT_APP_PASSWORD: "bot-password",
    });

    expect(config.provider).toBe("bitbucket");
    expect(config.github?.kvCache).toBeDefined();
    expect(config.bitbucket).toEqual({
      workspace: "acme",
      clientId: "client-id",
      clientSecret: "client-secret",
      botUsername: "bot-user",
      botAppPassword: "bot-password",
    });
  });

  it("infers bitbucket for provider config when SCM_PROVIDER is unset", () => {
    const config = getSourceControlProviderFactoryConfig({
      REPOS_CACHE: {} as KVNamespace,
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_CLIENT_ID: "client-id",
      BITBUCKET_CLIENT_SECRET: "client-secret",
    });

    expect(config.provider).toBe("bitbucket");
  });
});
