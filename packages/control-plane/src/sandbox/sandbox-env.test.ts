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

    expect(JSON.parse(env.SESSION_CONFIG)).toEqual({
      session_id: "session-1",
      runtime_mode: "execution",
      bridge_early_connect: true,
    });
    expect(env).not.toHaveProperty("SANDBOX_AUTH_TOKEN");
    expect(env).not.toHaveProperty("REPO_OWNER");
    expect(env).not.toHaveProperty("VCS_HOST");
  });
});
