import { describe, it, expect } from "vitest";
import {
  applyScmCloneEnv,
  buildSandboxEnvVars,
  buildSessionConfig,
  legacyScmCloneIdentity,
  scmCloneIdentity,
} from "./sandbox-env";
import type { CreateSandboxConfig } from "./provider";

const baseInput = {
  sessionId: "session-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

describe("buildSessionConfig", () => {
  it("maps provider inputs to the snake_case runtime contract", () => {
    const mcpServers = [{ id: "mcp-1", name: "Tool", type: "local" as const, enabled: true }];

    expect(buildSessionConfig({ ...baseInput, branch: "feature/x", mcpServers })).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcp_servers: mcpServers,
      branch: "feature/x",
    });
  });

  it("omits branch when not provided", () => {
    expect(buildSessionConfig(baseInput)).not.toHaveProperty("branch");
  });

  it("preserves null branch values", () => {
    expect(buildSessionConfig({ ...baseInput, branch: null })).toEqual(
      expect.objectContaining({ branch: null })
    );
  });

  it("maps multi-repo members to snake_case wire fields", () => {
    const config = buildSessionConfig({
      ...baseInput,
      repositories: [
        { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
      ],
    });

    expect(config.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main" },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop" },
    ]);
  });

  it("threads immutable diff baselines through the canonical runtime config", () => {
    const config = buildSessionConfig({
      ...baseInput,
      repositories: [
        {
          repoOwner: "testowner",
          repoName: "testrepo",
          baseBranch: "main",
          baseSha: "a".repeat(40),
        },
      ],
    });

    expect(config.repositories).toEqual([
      {
        repo_owner: "testowner",
        repo_name: "testrepo",
        branch: "main",
        base_sha: "a".repeat(40),
      },
    ]);
  });

  it("omits repositories for single-repo inputs", () => {
    const parsed = JSON.parse(JSON.stringify(buildSessionConfig(baseInput)));

    expect(parsed).not.toHaveProperty("repositories");
  });

  it("serializes to a SESSION_CONFIG that omits undefined mcp_servers", () => {
    // With no MCP servers configured, the key must not appear in the serialized
    // payload — the runtime treats an absent key and an empty list identically.
    const parsed = JSON.parse(JSON.stringify(buildSessionConfig(baseInput)));

    expect(parsed).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(parsed).not.toHaveProperty("mcp_servers");
  });
});

describe("scmCloneIdentity", () => {
  it("maps each SCM provider to its clone host and username", () => {
    expect(scmCloneIdentity("github")).toEqual({
      host: "github.com",
      cloneUsername: "x-access-token",
    });
    expect(scmCloneIdentity("gitlab")).toEqual({
      host: "gitlab.com",
      cloneUsername: "oauth2",
    });
    expect(scmCloneIdentity("bitbucket")).toEqual({
      host: "bitbucket.org",
      cloneUsername: "x-token-auth",
    });
  });
});

describe("legacyScmCloneIdentity", () => {
  it("resolves gitlab normally", () => {
    expect(legacyScmCloneIdentity("gitlab")).toEqual(scmCloneIdentity("gitlab"));
  });

  it("collapses bitbucket to the GitHub identity (historical pre-Bitbucket behavior)", () => {
    expect(legacyScmCloneIdentity("bitbucket")).toEqual(scmCloneIdentity("github"));
    expect(legacyScmCloneIdentity("github")).toEqual(scmCloneIdentity("github"));
  });
});

describe("applyScmCloneEnv", () => {
  it("sets host and username, adding the clone token only when given", () => {
    const envVars: Record<string, string> = {};
    applyScmCloneEnv(envVars, scmCloneIdentity("gitlab"));
    expect(envVars).toEqual({ VCS_HOST: "gitlab.com", VCS_CLONE_USERNAME: "oauth2" });

    applyScmCloneEnv(envVars, scmCloneIdentity("github"), "one-shot-token");
    expect(envVars).toEqual({
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
      VCS_CLONE_TOKEN: "one-shot-token",
    });
  });
});

describe("buildSandboxEnvVars", () => {
  const baseConfig: CreateSandboxConfig = {
    sessionId: "session-123",
    sandboxId: "sandbox-456",
    repoOwner: "testowner",
    repoName: "testrepo",
    controlPlaneUrl: "https://control-plane.test",
    sandboxAuthToken: "auth-token-abc",
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4-5",
  };

  it("assembles the canonical system env on top of user vars", () => {
    const envVars = buildSandboxEnvVars(
      { ...baseConfig, userEnvVars: { USER_SECRET: "value" } },
      { scmIdentity: scmCloneIdentity("github") }
    );

    expect(envVars).toEqual({
      USER_SECRET: "value",
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: "sandbox-456",
      CONTROL_PLANE_URL: "https://control-plane.test",
      SANDBOX_AUTH_TOKEN: "auth-token-abc",
      REPO_OWNER: "testowner",
      REPO_NAME: "testrepo",
      SESSION_CONFIG: expect.any(String),
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
    });
    expect(JSON.parse(envVars.SESSION_CONFIG)).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });
    // No embedded git tokens — the sandbox brokers credentials per-request.
    expect(envVars).not.toHaveProperty("VCS_CLONE_TOKEN");
    expect(envVars).not.toHaveProperty("GITHUB_TOKEN");
    expect(envVars).not.toHaveProperty("GITHUB_APP_TOKEN");
  });

  it("system vars take precedence over user-defined repo secrets", () => {
    const envVars = buildSandboxEnvVars(
      {
        ...baseConfig,
        userEnvVars: { SANDBOX_ID: "user-override", VCS_HOST: "evil.example" },
      },
      { scmIdentity: scmCloneIdentity("github") }
    );

    expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    expect(envVars.VCS_HOST).toBe("github.com");
  });

  it("serializes null repo identity to empty strings", () => {
    const envVars = buildSandboxEnvVars(
      { ...baseConfig, repoOwner: null, repoName: null },
      { scmIdentity: scmCloneIdentity("github") }
    );

    expect(envVars.REPO_OWNER).toBe("");
    expect(envVars.REPO_NAME).toBe("");
  });

  it("gates code-server port on codeServerEnabled and password on presence", () => {
    const disabled = buildSandboxEnvVars(baseConfig, {
      scmIdentity: scmCloneIdentity("github"),
    });
    expect(disabled).not.toHaveProperty("CODE_SERVER_PORT");
    expect(disabled).not.toHaveProperty("CODE_SERVER_PASSWORD");

    const enabled = buildSandboxEnvVars(
      { ...baseConfig, codeServerEnabled: true, sandboxSettings: { codeServerPort: 3000 } },
      { scmIdentity: scmCloneIdentity("github"), codeServerPassword: "pw" }
    );
    expect(enabled.CODE_SERVER_PORT).toBe("3000");
    expect(enabled.CODE_SERVER_PASSWORD).toBe("pw");
  });

  it("sets the slack-notify flag only when enabled", () => {
    expect(
      buildSandboxEnvVars(baseConfig, { scmIdentity: scmCloneIdentity("github") })
    ).not.toHaveProperty("AGENT_SLACK_NOTIFY_ENABLED");

    expect(
      buildSandboxEnvVars(
        { ...baseConfig, agentSlackNotifyEnabled: true },
        { scmIdentity: scmCloneIdentity("github") }
      ).AGENT_SLACK_NOTIFY_ENABLED
    ).toBe("true");
  });

  it("uses baseEnvVars as the user layer when provided, still overlaid by system vars", () => {
    const envVars = buildSandboxEnvVars(
      { ...baseConfig, userEnvVars: { IGNORED: "yes" } },
      {
        scmIdentity: scmCloneIdentity("github"),
        baseEnvVars: { LLM_KEY: "sk-provider", SANDBOX_ID: "seed-override" },
      }
    );

    expect(envVars.LLM_KEY).toBe("sk-provider");
    expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    expect(envVars).not.toHaveProperty("IGNORED");
  });
});
