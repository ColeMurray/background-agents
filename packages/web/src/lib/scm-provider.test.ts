import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerScmProvider } from "./scm-provider";

describe("getServerScmProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("infers bitbucket when explicit SCM_PROVIDER is unset and only bitbucket config is present", () => {
    delete process.env.SCM_PROVIDER;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    process.env.BITBUCKET_CLIENT_ID = "bitbucket-client-id";
    process.env.BITBUCKET_CLIENT_SECRET = "bitbucket-client-secret";

    expect(getServerScmProvider()).toBe("bitbucket");
  });

  it("keeps explicit SCM_PROVIDER precedence over inferred provider config", () => {
    process.env.SCM_PROVIDER = "github";
    process.env.BITBUCKET_CLIENT_ID = "bitbucket-client-id";
    process.env.BITBUCKET_CLIENT_SECRET = "bitbucket-client-secret";

    expect(getServerScmProvider()).toBe("github");
  });
});
