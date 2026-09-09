import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  applyScmCloneEnv,
  BOOT_MODE_ENV_KEYS,
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  buildSandboxEnvVars,
  buildSessionConfig,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  REPO_IMAGE_CALLBACK_ENV,
  RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS,
  scmCloneIdentity,
} from "./sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  type CreateSandboxConfig,
  type ImageBuildProviderTriggerConfig,
} from "./provider";

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
  it("maps each SCM provider to its clone host, username, and secret hosts", () => {
    expect(scmCloneIdentity("github")).toEqual({
      host: "github.com",
      cloneUsername: "x-access-token",
      secretHosts: ["github.com", "api.github.com"],
    });
    expect(scmCloneIdentity("gitlab")).toEqual({
      host: "gitlab.com",
      cloneUsername: "oauth2",
      secretHosts: ["gitlab.com", "api.gitlab.com"],
    });
    expect(scmCloneIdentity("bitbucket")).toEqual({
      host: "bitbucket.org",
      cloneUsername: "x-token-auth",
      secretHosts: ["bitbucket.org", "api.bitbucket.org"],
    });
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
      SANDBOX_TIMEOUT_SECONDS: String(DEFAULT_SANDBOX_TIMEOUT_SECONDS),
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

  it("passes a configured sandbox timeout to the runtime", () => {
    const envVars = buildSandboxEnvVars(
      { ...baseConfig, timeoutSeconds: 14_400 },
      { scmIdentity: scmCloneIdentity("github") }
    );

    expect(envVars.SANDBOX_TIMEOUT_SECONDS).toBe("14400");
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

  it("injects VNC credentials and port only when enabled", () => {
    const disabled = buildSandboxEnvVars(
      {
        ...baseConfig,
        userEnvVars: { VNC_PASSWORD: "user-password", NOVNC_PORT: "9999" },
      },
      { scmIdentity: scmCloneIdentity("github"), vncPassword: "derived-password" }
    );
    expect(disabled).not.toHaveProperty("VNC_PASSWORD");
    expect(disabled).not.toHaveProperty("NOVNC_PORT");

    const enabled = buildSandboxEnvVars(
      { ...baseConfig, vncEnabled: true, sandboxSettings: { vncPort: 6099 } },
      { scmIdentity: scmCloneIdentity("github"), vncPassword: "derived-password" }
    );
    expect(enabled.VNC_PASSWORD).toBe("derived-password");
    expect(enabled.NOVNC_PORT).toBe("6099");
  });

  it("strips boot-mode markers from the user layer", () => {
    // Providers add these after buildSandboxEnvVars returns, and only when the
    // mode is real, so they are not part of the system overlay that shadows user
    // vars. A repo secret of the same name would otherwise reach
    // BootMode.from_env and let a plain session claim it booted from a repo
    // image, a snapshot, or an image build.
    const envVars = buildSandboxEnvVars(
      {
        ...baseConfig,
        userEnvVars: {
          FROM_REPO_IMAGE: "true",
          REPO_IMAGE_SHA: "deadbeef",
          RESTORED_FROM_SNAPSHOT: "true",
          IMAGE_BUILD_MODE: "true",
          LEGITIMATE_SECRET: "keep-me",
        },
      },
      { scmIdentity: scmCloneIdentity("github") }
    );

    for (const marker of BOOT_MODE_ENV_KEYS) {
      expect(envVars).not.toHaveProperty(marker);
    }
    expect(envVars.LEGITIMATE_SECRET).toBe("keep-me");
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

describe("sandbox access passwords", () => {
  it("uses deterministic, distinct HMAC domains for code-server and VNC", async () => {
    const codePassword = await deriveCodeServerPassword("sandbox-456", "secret");
    const vncPassword = await deriveVncPassword("sandbox-456", "secret");

    expect(await deriveVncPassword("sandbox-456", "secret")).toBe(vncPassword);
    expect(vncPassword).not.toBe(codePassword);
    expect(vncPassword).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});

describe("buildImageBuildEnvVars", () => {
  const repositories = [
    { repoOwner: "acme", repoName: "web", baseBranch: "main" },
    { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
  ];

  it("assembles the full build-mode env on top of user vars", () => {
    const envVars = buildImageBuildEnvVars({
      sandboxId: "build-env-env_flagship",
      repositories,
      scmIdentity: scmCloneIdentity("github"),
      cloneToken: "clone-token",
      baseEnvVars: { USER_SECRET: "value" },
    });

    expect(envVars).toEqual({
      USER_SECRET: "value",
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: "build-env-env_flagship",
      REPO_OWNER: "acme",
      REPO_NAME: "web",
      IMAGE_BUILD_MODE: "true",
      SESSION_CONFIG: expect.any(String),
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
      VCS_CLONE_TOKEN: "clone-token",
    });
  });

  it("serializes a repositories-bearing SESSION_CONFIG anchored to the primary branch", () => {
    const envVars = buildImageBuildEnvVars({
      sandboxId: "build-env-env_flagship",
      repositories,
      scmIdentity: scmCloneIdentity("github"),
    });

    expect(JSON.parse(envVars.SESSION_CONFIG)).toEqual({
      branch: "main",
      repositories: [
        { repo_owner: "acme", repo_name: "web", branch: "main" },
        { repo_owner: "acme", repo_name: "api", branch: "develop" },
      ],
    });
  });

  it("scrubs every reserved callback key from the user layer", () => {
    const baseEnvVars: Record<string, string> = { SAFE: "kept" };
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      baseEnvVars[key] = "user-controlled";
    }

    const envVars = buildImageBuildEnvVars({
      sandboxId: "build-env-env_flagship",
      repositories,
      scmIdentity: scmCloneIdentity("github"),
      baseEnvVars,
    });

    expect(envVars.SAFE).toBe("kept");
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      expect(envVars).not.toHaveProperty(key);
    }
  });

  it("throws when the repository list is empty", () => {
    expect(() =>
      buildImageBuildEnvVars({
        sandboxId: "build-env-env_flagship",
        repositories: [],
        scmIdentity: scmCloneIdentity("github"),
      })
    ).toThrow("image build requires at least one repository");
  });
});

describe("imageBuildSandboxIdentity", () => {
  const config: ImageBuildProviderTriggerConfig = {
    buildId: "build-1",
    scopeKind: "repo",
    scopeId: "acme/web",
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    callbackUrl: "https://cp.test/image-builds/build-complete",
    failureCallbackUrl: "https://cp.test/image-builds/build-failed",
    callbackToken: "callback-token",
    buildExecutionTimeoutSeconds: 1800,
    providerSessionTimeoutSeconds: 2400,
    onProviderSessionCreated: async () => undefined,
    correlation: { trace_id: "trace-1", request_id: "request-1" },
  };

  it("derives a stable sandbox id, a per-attempt name, and scope-carrying labels", () => {
    expect(imageBuildSandboxIdentity(config, 1234)).toEqual({
      sandboxId: "build-env-acme/web",
      sandboxName: "build-env-acme/web-1234",
      labels: {
        openinspect_framework: "open-inspect",
        openinspect_kind: "environment-image-build",
        openinspect_build_id: "build-1",
        openinspect_scope_kind: "repo",
        openinspect_scope_id: "acme/web",
      },
    });
  });

  it("is deterministic for a fixed timestamp", () => {
    expect(imageBuildSandboxIdentity(config, 99)).toEqual(imageBuildSandboxIdentity(config, 99));
  });
});

describe("buildImageBuildCallbackEnv", () => {
  const values = {
    buildId: "build-1",
    callbackUrl: "https://cp.test/image-builds/build-complete",
    failureCallbackUrl: "https://cp.test/image-builds/build-failed",
    token: "callback-token",
  };

  it("assembles the full callback env record from semantic values", () => {
    expect(buildImageBuildCallbackEnv({ ...values, providerSessionId: "session-9" })).toEqual({
      OI_REPO_IMAGE_BUILD_ID: "build-1",
      OI_REPO_IMAGE_CALLBACK_URL: "https://cp.test/image-builds/build-complete",
      OI_REPO_IMAGE_FAILURE_CALLBACK_URL: "https://cp.test/image-builds/build-failed",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "session-9",
    });
  });

  it("omits the provider session id key when the id is not yet known", () => {
    expect(buildImageBuildCallbackEnv(values)).toEqual({
      OI_REPO_IMAGE_BUILD_ID: "build-1",
      OI_REPO_IMAGE_CALLBACK_URL: "https://cp.test/image-builds/build-complete",
      OI_REPO_IMAGE_FAILURE_CALLBACK_URL: "https://cp.test/image-builds/build-failed",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
    });
  });
});

describe("cross-plane env-key contract manifest", () => {
  // Single source of the cross-plane contract; the Python halves (runtime
  // constants, Modal's RESERVED_USER_ENV_KEYS) are pinned to the same file in
  // packages/modal-infra/tests/test_build_sandbox_lifecycle.py. Tests-only
  // consumption: the runtime constants stay as code.
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../../sandbox-runtime/src/sandbox_runtime/image_build_callback_env.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    callback_env: Record<string, string>;
    build_mode_env_var: string;
    execution_timeout_env_var: string;
    reserved_only_control_plane: string[];
    reserved_only_modal: string[];
  };

  it("pins REPO_IMAGE_CALLBACK_ENV to the manifest by value", () => {
    expect(REPO_IMAGE_CALLBACK_ENV).toEqual({
      buildId: manifest.callback_env.build_id,
      callbackUrl: manifest.callback_env.callback_url,
      failureCallbackUrl: manifest.callback_env.failure_callback_url,
      token: manifest.callback_env.token,
      providerSessionId: manifest.callback_env.provider_session_id,
    });
  });

  it("pins the build-mode marker and execution-timeout key to the manifest", () => {
    expect(IMAGE_BUILD_MODE_ENV_VAR).toBe(manifest.build_mode_env_var);
    expect(IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY).toBe(manifest.execution_timeout_env_var);
  });

  it("pins the reserved scrub list to the callback keys plus the control-plane-only extras", () => {
    expect([...RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS].sort()).toEqual(
      [...Object.values(manifest.callback_env), ...manifest.reserved_only_control_plane].sort()
    );
    // The Modal-only reserved key is scrubbed on the Python side, never here.
    for (const key of manifest.reserved_only_modal) {
      expect(RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS).not.toContain(key);
    }
  });
});
