import { describe, expect, it } from "vitest";
import { buildSandboxEnvVars, buildSessionConfig } from "./sandbox-env";

const input = {
  sessionId: "session-1",
  repoOwner: "acme",
  repoName: "repo",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("buildSessionConfig runtime mode", () => {
  it("preserves the legacy agent payload when no mode is supplied", () => {
    expect(buildSessionConfig(input)).not.toHaveProperty("runtime_mode");
  });

  it("marks an execution-only sandbox explicitly", () => {
    expect(buildSessionConfig({ ...input, harness: "pi", runtimeMode: "execution" })).toEqual({
      session_id: "session-1",
      repo_owner: "acme",
      repo_name: "repo",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      mcp_servers: undefined,
      bridge_early_connect: true,
      runtime_mode: "execution",
    });
  });

  it("carries execution mode through the REST-provider environment builder", () => {
    const env = buildSandboxEnvVars(
      {
        ...input,
        runtimeMode: "execution",
        sandboxId: "sandbox-1",
        controlPlaneUrl: "https://control.example",
        sandboxAuthToken: "token",
      },
      { scmIdentity: { host: "github.com", cloneUsername: "x-access-token", secretHosts: [] } }
    );

    expect(JSON.parse(env.SESSION_CONFIG)).toMatchObject({ runtime_mode: "execution" });
  });
});
