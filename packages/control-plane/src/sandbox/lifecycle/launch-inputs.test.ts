import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import {
  resolveLaunchInputs,
  type LaunchInputConfig,
  type LaunchInputContext,
} from "./launch-inputs";

const mcpServers: McpServerConfig[] = [
  { id: "mcp", name: "tools", type: "remote", url: "https://mcp.test", enabled: true },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("resolveLaunchInputs", () => {
  let session: Parameters<typeof resolveLaunchInputs>[0];
  let context: LaunchInputContext;
  let config: LaunchInputConfig;
  let provider: Parameters<typeof resolveLaunchInputs>[3];
  let log: ReturnType<typeof createLogger>;

  beforeEach(() => {
    session = {
      id: "session-123",
      session_name: "test-session",
      model: "openai/gpt-5.3-codex",
      repo_owner: "group/subgroup",
      repo_name: "repo",
      base_branch: "dev",
      code_server_enabled: 0,
      vnc_enabled: 0,
      sandbox_settings: null,
    };
    context = {
      getSessionRepositories: vi.fn(() => []),
      getUserEnvVars: vi.fn(async () => undefined),
    };
    config = {
      model: "anthropic/claude-sonnet-4-5",
      controlPlaneUrl: "https://test.workers.dev",
    };
    provider = { name: "mock", capabilities: { supportsSandboxTimeout: true } };
    log = createLogger("launch-inputs-test");
    vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  it("resolves common config with session overrides and scoped lookups", async () => {
    const repositories = [
      { repoOwner: "group/subgroup", repoName: "repo", baseBranch: "dev", baseSha: "abc" },
    ];
    const sandboxSettings = {
      tunnelPorts: [3000],
      cpuCores: 2,
      memoryMib: 4096,
      sandboxTimeoutMs: 14_400_000,
    };
    context.getSessionRepositories = vi.fn(() => repositories);
    context.getUserEnvVars = vi.fn(async () => ({ TOKEN: "value" }));
    config.mcpServerLookup = { getDecryptedForSession: vi.fn(async () => mcpServers) };
    config.slackAgentNotifyLookup = { isEnabledForRepo: vi.fn(async () => true) };
    session.code_server_enabled = 1;
    session.vnc_enabled = 1;
    session.sandbox_settings = JSON.stringify(sandboxSettings);

    expect(await resolveLaunchInputs(session, context, config, provider, log)).toEqual({
      sessionId: "test-session",
      repositories,
      inputs: {
        repoOwner: "group/subgroup",
        repoName: "repo",
        branch: "dev",
        repositories,
        controlPlaneUrl: config.controlPlaneUrl,
        provider: "openai",
        model: "gpt-5.3-codex",
        userEnvVars: { TOKEN: "value" },
        codeServerEnabled: true,
        vncEnabled: true,
        agentSlackNotifyEnabled: true,
        mcpServers,
        sandboxSettings,
        timeoutSeconds: 14_400,
      },
    });
    expect(config.mcpServerLookup.getDecryptedForSession).toHaveBeenCalledExactlyOnceWith([
      { repoOwner: "group/subgroup", repoName: "repo" },
    ]);
    expect(config.slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledExactlyOnceWith(
      "group/subgroup",
      "repo"
    );
    expect(log.info).toHaveBeenCalledWith("MCP servers loaded", {
      event: "mcp.loaded",
      count: 1,
      names: ["tools"],
    });
  });

  it.each(["absent", "empty", "failed"] as const)(
    "uses defaults with %s lookups",
    async (state) => {
      session.session_name = null;
      session.model = "";
      if (state !== "absent") {
        config.mcpServerLookup = {
          getDecryptedForSession: vi.fn(async () => {
            if (state === "failed") throw new Error("lookup unavailable");
            return [];
          }),
        };
        config.slackAgentNotifyLookup = {
          isEnabledForRepo: vi.fn(async () => {
            if (state === "failed") throw new Error("lookup unavailable");
            return false;
          }),
        };
      }
      const { sessionId, inputs } = await resolveLaunchInputs(
        session,
        context,
        config,
        provider,
        log
      );
      expect(sessionId).toBe("session-123");
      expect(inputs).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        userEnvVars: undefined,
        mcpServers: undefined,
        agentSlackNotifyEnabled: false,
        codeServerEnabled: false,
        vncEnabled: false,
        sandboxSettings: {},
        timeoutSeconds: undefined,
      });
      expect(log.warn).toHaveBeenCalledTimes(state === "failed" ? 2 : 0);
    }
  );

  it("logs malformed settings and uses defaults", async () => {
    session.sandbox_settings = "{invalid";
    const { inputs } = await resolveLaunchInputs(session, context, config, provider, log);
    expect(inputs.sandboxSettings).toEqual({});
    expect(inputs.timeoutSeconds).toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "Failed to parse sandbox_settings, using defaults"
    );
  });

  it.each([
    { shape: "repo-less", repositories: [], includeList: false },
    {
      shape: "single",
      repositories: [{ repoOwner: "owner", repoName: "repo", baseBranch: "main" }],
      includeList: false,
    },
    {
      shape: "empty pin",
      repositories: [{ repoOwner: "owner", repoName: "repo", baseBranch: "main", baseSha: "" }],
      includeList: false,
    },
    {
      shape: "pinned",
      repositories: [{ repoOwner: "owner", repoName: "repo", baseBranch: "main", baseSha: "sha" }],
      includeList: true,
    },
    {
      shape: "multi",
      repositories: [
        { repoOwner: "owner", repoName: "repo", baseBranch: "main" },
        { repoOwner: "owner", repoName: "other", baseBranch: "dev" },
      ],
      includeList: true,
    },
  ])(
    "preserves $shape repository wire shape and lookup scope",
    async ({ repositories, includeList }) => {
      const primary = repositories[0];
      session.repo_owner = primary?.repoOwner ?? null;
      session.repo_name = primary?.repoName ?? null;
      session.base_branch = primary?.baseBranch ?? null;
      context.getSessionRepositories = vi.fn(() => repositories);
      config.mcpServerLookup = { getDecryptedForSession: vi.fn(async () => []) };
      config.slackAgentNotifyLookup = { isEnabledForRepo: vi.fn(async () => false) };
      const result = await resolveLaunchInputs(session, context, config, provider, log);
      expect(result.repositories).toBe(repositories);
      expect(Object.hasOwn(result.inputs, "repositories")).toBe(includeList);
      if (includeList) expect(result.inputs.repositories).toBe(repositories);
      expect(result.inputs).toMatchObject({
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        branch: session.base_branch,
      });
      expect(config.mcpServerLookup.getDecryptedForSession).toHaveBeenCalledExactlyOnceWith(
        repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
      );
      expect(config.slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledExactlyOnceWith(
        session.repo_owner,
        session.repo_name
      );
    }
  );

  it("rejects a configured timeout unsupported by the provider", async () => {
    session.sandbox_settings = '{"sandboxTimeoutMs":14400000}';
    provider.capabilities.supportsSandboxTimeout = false;
    await expect(
      resolveLaunchInputs(session, context, config, provider, log)
    ).rejects.toMatchObject({
      message: "mock does not support configurable sandbox timeouts",
      errorType: "permanent",
    });
  });

  it("omits an unconfigured timeout for a provider without timeout support", async () => {
    provider.capabilities.supportsSandboxTimeout = false;
    const { inputs } = await resolveLaunchInputs(session, context, config, provider, log);
    expect(inputs.timeoutSeconds).toBeUndefined();
  });

  it("reads repositories synchronously and starts every external read before any resolves", async () => {
    const env = deferred<Record<string, string>>();
    const mcp = deferred<McpServerConfig[]>();
    const slack = deferred<boolean>();
    const calls: string[] = [];
    context.getSessionRepositories = () => {
      calls.push("repositories");
      return [];
    };
    context.getUserEnvVars = () => {
      calls.push("env");
      return env.promise;
    };
    config.mcpServerLookup = {
      getDecryptedForSession: () => {
        calls.push("mcp");
        return mcp.promise;
      },
    };
    config.slackAgentNotifyLookup = {
      isEnabledForRepo: () => {
        calls.push("slack");
        return slack.promise;
      },
    };

    const resolving = resolveLaunchInputs(session, context, config, provider, log);
    expect(calls).toEqual(["repositories", "env", "mcp", "slack"]);
    slack.resolve(true);
    mcp.resolve(mcpServers);
    env.resolve({ TOKEN: "value" });
    expect((await resolving).inputs).toMatchObject({
      userEnvVars: { TOKEN: "value" },
      mcpServers,
      agentSlackNotifyEnabled: true,
    });
  });

  it("propagates user environment rejection while optional reads are pending", async () => {
    const env = deferred<Record<string, string>>();
    const mcp = deferred<McpServerConfig[]>();
    const slack = deferred<boolean>();
    context.getUserEnvVars = () => env.promise;
    config.mcpServerLookup = { getDecryptedForSession: vi.fn(() => mcp.promise) };
    config.slackAgentNotifyLookup = { isEnabledForRepo: vi.fn(() => slack.promise) };
    const resolving = resolveLaunchInputs(session, context, config, provider, log);
    const error = new Error("env unavailable");
    const rejection = expect(resolving).rejects.toBe(error);
    env.reject(error);
    await rejection;
    expect(config.mcpServerLookup.getDecryptedForSession).toHaveBeenCalledOnce();
    expect(config.slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledOnce();
    mcp.resolve([]);
    slack.resolve(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["mcp", "slack"] as const)(
    "fails open for %s without losing the other result",
    async (failed) => {
      config.mcpServerLookup = {
        getDecryptedForSession: vi.fn(async () => {
          if (failed === "mcp") throw new Error("mcp unavailable");
          return mcpServers;
        }),
      };
      config.slackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => {
          if (failed === "slack") throw new Error("slack unavailable");
          return true;
        }),
      };
      context.getUserEnvVars = vi.fn(async () => ({ TOKEN: "value" }));
      const { inputs } = await resolveLaunchInputs(session, context, config, provider, log);
      expect(inputs).toMatchObject({
        userEnvVars: { TOKEN: "value" },
        mcpServers: failed === "mcp" ? undefined : mcpServers,
        agentSlackNotifyEnabled: failed !== "slack",
      });
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        event: failed === "mcp" ? "mcp.load_failed" : "slack_notify.gate_resolve_failed",
        error: failed === "mcp" ? "Error: mcp unavailable" : "slack unavailable",
      });
    }
  );
});
