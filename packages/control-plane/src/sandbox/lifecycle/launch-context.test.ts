import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HARNESS } from "@open-inspect/shared/harnesses";
import { DEFAULT_MODEL, extractProviderAndModel } from "@open-inspect/shared/models";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import type { SessionRow } from "../../session/types";
import { SandboxProviderError, type SessionRepositoryInfo } from "../provider";
import type { ImageBuildLookup, ImageBuildSpawnRow, SelectedImageBuild } from "./image-selection";
import {
  SandboxLaunchContext,
  resolveImageBuildScope,
  type McpServerLookup,
  type SandboxLaunchContextDependencies,
  type SandboxLaunchContextReader,
  type SlackAgentNotifyLookup,
} from "./launch-context";
import { createMockSession } from "./test-helpers";

const CONFIGURED_MODEL = "openai/gpt-5.4";
const PRIMARY: SessionRepositoryInfo = {
  repoOwner: "testowner",
  repoName: "testrepo",
  baseBranch: "main",
};
const SECONDARY: SessionRepositoryInfo = {
  repoOwner: "Group/Subgroup",
  repoName: "API",
  baseBranch: "develop",
};
const SELECTED_IMAGE: SelectedImageBuild = {
  imageBuildId: "build-1",
  providerImageId: "image-1",
  primaryBaseSha: "baked-testrepo",
  runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
};

function fixture(overrides: Partial<SandboxLaunchContextDependencies> = {}) {
  const sessionContext = {
    getSessionRepositories: vi.fn<SandboxLaunchContextReader["getSessionRepositories"]>(() => []),
    getUserEnvVars: vi.fn<SandboxLaunchContextReader["getUserEnvVars"]>(async () => undefined),
  };
  const imageBuildLookup = {
    getLatestReady: vi.fn<ImageBuildLookup["getLatestReady"]>(async () => null),
    markRestoreFailed: vi.fn<ImageBuildLookup["markRestoreFailed"]>(async () => true),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const getLogger = vi.fn(() => logger);
  const context = new SandboxLaunchContext({
    sessionContext,
    provider: { name: "modal", capabilities: { supportsSandboxTimeout: true } },
    config: { model: CONFIGURED_MODEL },
    imageBuildLookup,
    getLogger,
    ...overrides,
  });
  return { context, sessionContext, imageBuildLookup, logger, getLogger };
}

async function readyImage(repositories: SessionRepositoryInfo[]): Promise<ImageBuildSpawnRow> {
  return {
    id: SELECTED_IMAGE.imageBuildId,
    provider_image_id: SELECTED_IMAGE.providerImageId,
    repositories_fingerprint: await computeRepositoriesFingerprint(repositories),
    repository_shas: JSON.stringify(
      repositories.map(({ repoOwner, repoName }) => ({
        repoOwner,
        repoName,
        baseSha: `baked-${repoName}`,
      }))
    ),
    runtime_version: COMPATIBLE_RUNTIME_VERSION,
  };
}

describe("resolveImageBuildScope", () => {
  it.each([{ repositories: [PRIMARY, SECONDARY] }, { repositories: [] }])(
    "keeps the environment scope with members $repositories",
    ({ repositories }) => {
      const session = createMockSession({ environment_id: "environment-1" });
      expect(resolveImageBuildScope(session, repositories)).toEqual({
        kind: "environment",
        id: "environment-1",
      });
    }
  );

  it("uses the single member's normalized nested identity for an ad-hoc repo image", () => {
    expect(resolveImageBuildScope(createMockSession(), [SECONDARY])).toEqual({
      kind: "repo",
      id: "group/subgroup/api",
    });
  });

  it("synchronously excludes ad-hoc multi-repo images", () => {
    expect(resolveImageBuildScope(createMockSession(), [PRIMARY, SECONDARY])).toBeNull();
  });

  it("synchronously excludes repo-less ad-hoc images", () => {
    const session = createMockSession({ repo_owner: null, repo_name: null });
    expect(resolveImageBuildScope(session, [])).toBeNull();
  });
});

describe("SandboxLaunchContext", () => {
  it("does no dependency work at construction, even before a logger is available", () => {
    const getLogger = vi.fn(() => {
      throw new Error("session not initialized");
    });
    const mcpServerLookup = {
      getDecryptedForSession: vi.fn<McpServerLookup["getDecryptedForSession"]>(async () => []),
    };
    const slackAgentNotifyLookup = {
      isEnabledForRepo: vi.fn<SlackAgentNotifyLookup["isEnabledForRepo"]>(async () => true),
    };
    const getLegacyToken = vi.fn(async () => "restore-token");
    const f = fixture({
      getLogger,
      config: {
        model: CONFIGURED_MODEL,
        mcpServerLookup,
        slackAgentNotifyLookup,
        restoreCloneCredentials: {
          identity: { host: "gitlab.com", username: "oauth2" },
          getLegacyToken,
        },
      },
    });

    for (const dependency of [
      getLogger,
      ...Object.values(f.sessionContext),
      ...Object.values(f.imageBuildLookup),
      mcpServerLookup.getDecryptedForSession,
      slackAgentNotifyLookup.isEnabledForRepo,
      getLegacyToken,
    ]) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it("resolves the current logger at each use rather than caching construction context", () => {
    const f = fixture();
    const session = createMockSession({ sandbox_settings: "not-json" });
    f.context.resolveSandboxSettings(session);
    const nextLogger = { info: vi.fn(), warn: vi.fn() };
    f.getLogger.mockReturnValue(nextLogger);
    f.context.resolveSandboxSettings(session);

    expect(f.logger.warn).toHaveBeenCalledOnce();
    expect(nextLogger.warn).toHaveBeenCalledOnce();
    expect(f.getLogger).toHaveBeenCalledTimes(2);
  });

  describe("resolveRestoreCloneCredentials", () => {
    const identity = { host: "gitlab.com", username: "oauth2" };

    it.each(["v62-compatible", "v71-before-helper"])(
      "requires wake-time credentials for %s",
      async (version) => {
        const getLegacyToken = vi.fn(async () => "restore-token");
        const { context } = fixture({
          config: {
            model: CONFIGURED_MODEL,
            restoreCloneCredentials: { identity, getLegacyToken },
          },
        });
        expect(getLegacyToken).not.toHaveBeenCalled();

        expect(await context.resolveRestoreCloneCredentials(createMockSession(), version)).toEqual({
          identity,
          legacyToken: "restore-token",
        });
        getLegacyToken.mockResolvedValueOnce("new-token");
        expect(await context.resolveRestoreCloneCredentials(createMockSession(), version)).toEqual({
          identity,
          legacyToken: "new-token",
        });
        expect(getLegacyToken).toHaveBeenCalledTimes(2);
      }
    );

    it.each(["v72-credential-helper", COMPATIBLE_RUNTIME_VERSION])(
      "preserves GitLab identity without minting for %s",
      async (version) => {
        const getLegacyToken = vi.fn(async () => {
          throw new Error("mint unavailable");
        });
        const { context } = fixture({
          config: {
            model: CONFIGURED_MODEL,
            restoreCloneCredentials: { identity, getLegacyToken },
          },
        });

        expect(await context.resolveRestoreCloneCredentials(createMockSession(), version)).toEqual({
          identity,
        });
        expect(getLegacyToken).not.toHaveBeenCalled();
      }
    );

    it("preserves identity without minting for repository-less legacy restores", async () => {
      const getLegacyToken = vi.fn(async () => "restore-token");
      const { context } = fixture({
        config: { model: CONFIGURED_MODEL, restoreCloneCredentials: { identity, getLegacyToken } },
      });

      expect(
        await context.resolveRestoreCloneCredentials(
          createMockSession({ repo_owner: null, repo_name: null }),
          "v62-compatible"
        )
      ).toEqual({ identity });
      expect(getLegacyToken).not.toHaveBeenCalled();
    });

    it("rejects Modal restore without configured credentials", async () => {
      await expect(
        fixture().context.resolveRestoreCloneCredentials(
          createMockSession(),
          COMPATIBLE_RUNTIME_VERSION
        )
      ).rejects.toThrow("Missing Modal restore credentials");
    });

    it("propagates legacy credential failure instead of launching without a required token", async () => {
      const getLegacyToken = vi.fn(async () => {
        throw new Error("credentials unavailable");
      });
      const { context } = fixture({
        config: { model: CONFIGURED_MODEL, restoreCloneCredentials: { identity, getLegacyToken } },
      });

      await expect(
        context.resolveRestoreCloneCredentials(createMockSession(), "v71-before-helper")
      ).rejects.toThrow("credentials unavailable");
    });

    it("rejects empty legacy tokens", async () => {
      const { context } = fixture({
        config: {
          model: CONFIGURED_MODEL,
          restoreCloneCredentials: { identity, getLegacyToken: async () => "" },
        },
      });
      await expect(
        context.resolveRestoreCloneCredentials(createMockSession(), "v71-before-helper")
      ).rejects.toThrow("requires a clone token");
    });
  });

  describe("resolveAgent", () => {
    it("uses the configured model and default harness for an absent legacy selection", () => {
      const { context } = fixture();
      // Legacy stored rows can predate the current non-null harness schema.
      const session = {
        ...createMockSession({ model: "" }),
        harness: undefined,
      } as unknown as SessionRow;

      expect(context.resolveAgent(session)).toEqual({
        provider: "openai",
        model: "gpt-5.4",
        harness: DEFAULT_HARNESS,
      });
    });

    it("honors a session model and harness, normalizing a bare model ID", () => {
      const { context } = fixture();

      expect(
        context.resolveAgent(createMockSession({ model: "claude-haiku-4-5", harness: "claude" }))
      ).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", harness: "claude" });
    });

    it("falls back to catalog defaults for invalid stored model and harness values", () => {
      const { context } = fixture();
      const session = {
        ...createMockSession({ model: "unknown/model" }),
        harness: "retired-harness",
      } as unknown as SessionRow;

      expect(context.resolveAgent(session)).toEqual({
        ...extractProviderAndModel(DEFAULT_MODEL),
        harness: DEFAULT_HARNESS,
      });
    });

    it.each(["openai/gpt-5.3-codex", "gpt-5.3-codex-spark"])(
      "migrates retired model %s to its replacement",
      (model) => {
        const { context } = fixture();

        expect(context.resolveAgent(createMockSession({ model }))).toEqual({
          provider: "openai",
          model: "gpt-6-sol",
          harness: DEFAULT_HARNESS,
        });
      }
    );
  });

  describe("resolveRepositories", () => {
    it("returns null scalar fields and no repository list for a repo-less session", () => {
      const f = fixture();
      const session = createMockSession({ repo_owner: null, repo_name: null, base_branch: null });

      expect(f.context.resolveRepositories(session)).toEqual({
        repositories: [],
        fields: { repoOwner: null, repoName: null, branch: null },
      });
      expect(f.sessionContext.getSessionRepositories).toHaveBeenCalledOnce();
    });

    it("keeps a single repository without a base SHA in scalar form", () => {
      const f = fixture();
      f.sessionContext.getSessionRepositories.mockReturnValue([PRIMARY]);

      expect(f.context.resolveRepositories(createMockSession())).toEqual({
        repositories: [PRIMARY],
        fields: { repoOwner: PRIMARY.repoOwner, repoName: PRIMARY.repoName, branch: "main" },
      });
    });

    it("preserves member order and nested owners, reading members anew on each call", () => {
      const f = fixture();
      const session = createMockSession({
        repo_owner: SECONDARY.repoOwner,
        repo_name: SECONDARY.repoName,
        base_branch: SECONDARY.baseBranch,
      });
      f.sessionContext.getSessionRepositories.mockReturnValueOnce([SECONDARY, PRIMARY]);
      const fields = { repoOwner: "Group/Subgroup", repoName: "API", branch: "develop" };

      expect(f.context.resolveRepositories(session)).toEqual({
        repositories: [SECONDARY, PRIMARY],
        fields: { ...fields, repositories: [SECONDARY, PRIMARY] },
      });
      f.sessionContext.getSessionRepositories.mockReturnValueOnce([SECONDARY]);
      expect(f.context.resolveRepositories(session)).toEqual({
        repositories: [SECONDARY],
        fields,
      });
      expect(f.sessionContext.getSessionRepositories).toHaveBeenCalledTimes(2);
    });

    it("includes the list for a single repository with an immutable base SHA", () => {
      const f = fixture();
      const repositories = [{ ...PRIMARY, baseSha: "session-start-sha" }];
      f.sessionContext.getSessionRepositories.mockReturnValue(repositories);

      expect(f.context.resolveRepositories(createMockSession())).toEqual({
        repositories,
        fields: {
          repoOwner: PRIMARY.repoOwner,
          repoName: PRIMARY.repoName,
          branch: PRIMARY.baseBranch,
          repositories,
        },
      });
    });
  });

  describe("prebuilt images", () => {
    it("selects only the environment image and uses its first baked SHA", async () => {
      const f = fixture();
      const repositories = [{ ...SECONDARY, baseSha: "session-start-sha" }, PRIMARY];
      f.imageBuildLookup.getLatestReady.mockResolvedValue(await readyImage(repositories));

      expect(
        await f.context.lookupImageBuildForSpawn(
          { kind: "environment", id: "environment-1" },
          repositories,
          DEFAULT_HARNESS
        )
      ).toEqual({ ...SELECTED_IMAGE, primaryBaseSha: "baked-API" });
      expect(f.imageBuildLookup.getLatestReady.mock.calls).toEqual([
        [{ kind: "environment", id: "environment-1" }],
      ]);
      expect(f.logger.info).toHaveBeenCalledWith("Using prebuilt image", {
        event: "image_build.spawn_selected",
        scope_kind: "environment",
        scope_id: "environment-1",
        image_build_id: "build-1",
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
      });
      expect(f.imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
    });

    it("does not fall back to a repo image after a single-repo environment miss", async () => {
      const f = fixture();

      expect(
        await f.context.lookupImageBuildForSpawn(
          { kind: "environment", id: "environment-1" },
          [PRIMARY],
          DEFAULT_HARNESS
        )
      ).toBeNull();
      expect(f.imageBuildLookup.getLatestReady.mock.calls).toEqual([
        [{ kind: "environment", id: "environment-1" }],
      ]);
      expect(f.logger.info).toHaveBeenCalledWith(
        "Prebuilt image miss, using base image",
        expect.objectContaining({ reason: "no_ready_image", scope_kind: "environment" })
      );
      expect(f.imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
    });

    it("passes an explicitly selected repo scope through lookup", async () => {
      const f = fixture();
      f.imageBuildLookup.getLatestReady.mockResolvedValue(await readyImage([SECONDARY]));

      expect(
        await f.context.lookupImageBuildForSpawn(
          { kind: "repo", id: "group/subgroup/api" },
          [SECONDARY],
          DEFAULT_HARNESS
        )
      ).toEqual({
        ...SELECTED_IMAGE,
        primaryBaseSha: "baked-API",
      });
      expect(f.imageBuildLookup.getLatestReady).toHaveBeenCalledExactlyOnceWith({
        kind: "repo",
        id: "group/subgroup/api",
      });
    });

    it("retains the async boundary for an empty environment without invoking lookup", async () => {
      const f = fixture();

      const lookup = f.context.lookupImageBuildForSpawn(
        { kind: "environment", id: "environment-1" },
        [],
        DEFAULT_HARNESS
      );
      expect(lookup).toBeInstanceOf(Promise);
      expect(await lookup).toBeNull();
      expect(f.imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("skips lookup and invalidation when no image lookup is configured", async () => {
      const f = fixture({ imageBuildLookup: undefined });

      const lookup = f.context.lookupImageBuildForSpawn(
        { kind: "repo", id: "testowner/testrepo" },
        [PRIMARY],
        DEFAULT_HARNESS
      );
      expect(lookup).toBeInstanceOf(Promise);
      expect(await lookup).toBeNull();
      await expect(
        f.context.markImageBuildRestoreFailed(SELECTED_IMAGE, new Error("unavailable"))
      ).resolves.toBeUndefined();
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("falls back on lookup failure without invalidating any image", async () => {
      const f = fixture();
      f.imageBuildLookup.getLatestReady.mockRejectedValue(new Error("lookup unavailable"));

      expect(
        await f.context.lookupImageBuildForSpawn(
          { kind: "repo", id: "testowner/testrepo" },
          [PRIMARY],
          DEFAULT_HARNESS
        )
      ).toBeNull();
      expect(f.imageBuildLookup.markRestoreFailed).not.toHaveBeenCalled();
      expect(f.logger.warn).toHaveBeenCalledWith(
        "Failed to look up prebuilt image, using base image",
        {
          event: "image_build.spawn_miss",
          scope_kind: "repo",
          scope_id: "testowner/testrepo",
          reason: "lookup_failed",
          error: "lookup unavailable",
        }
      );
    });

    it.each([new Error("artifact unavailable"), "artifact unavailable"])(
      "invalidates only on an explicit restore-failed call (%s)",
      async (error) => {
        const f = fixture();

        await f.context.markImageBuildRestoreFailed(SELECTED_IMAGE, error);

        expect(f.imageBuildLookup.markRestoreFailed).toHaveBeenCalledExactlyOnceWith(
          "build-1",
          "restore failed at spawn: artifact unavailable"
        );
        expect(f.imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
        expect(f.getLogger).not.toHaveBeenCalled();
      }
    );

    it("keeps explicit invalidation best effort when the store refuses or throws", async () => {
      const f = fixture();
      f.imageBuildLookup.markRestoreFailed
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error("store unavailable"));

      await expect(
        f.context.markImageBuildRestoreFailed(SELECTED_IMAGE, "artifact unavailable")
      ).resolves.toBeUndefined();
      await expect(
        f.context.markImageBuildRestoreFailed(SELECTED_IMAGE, "artifact unavailable")
      ).resolves.toBeUndefined();
      expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
        "Failed to mark prebuilt image restore-failed",
        { image_build_id: "build-1", error: "store unavailable" }
      );
    });
  });

  describe("getUserEnvVars", () => {
    it("forwards current user env values, including undefined, without copying or logging", async () => {
      const f = fixture();
      const env = { API_KEY: "user-secret" };
      f.sessionContext.getUserEnvVars.mockResolvedValueOnce(env);

      expect(await f.context.getUserEnvVars()).toBe(env);
      expect(await f.context.getUserEnvVars()).toBeUndefined();
      expect(f.sessionContext.getUserEnvVars.mock.calls).toEqual([[], []]);
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("propagates user env failures unchanged to the caller", async () => {
      const f = fixture();
      const error = new Error("decryption failed");
      f.sessionContext.getUserEnvVars.mockRejectedValue(error);

      await expect(f.context.getUserEnvVars()).rejects.toBe(error);
      expect(f.getLogger).not.toHaveBeenCalled();
    });
  });

  describe("loadMcpServers", () => {
    it("forwards ordered member identities and returns credentials without logging them", async () => {
      const servers: McpServerConfig[] = [
        {
          id: "local-1",
          name: "local",
          type: "local",
          command: ["mcp"],
          env: { TOKEN: "mcp-secret" },
          enabled: true,
        },
        {
          id: "remote-1",
          name: "remote",
          type: "remote",
          url: "https://mcp.example",
          headers: { Authorization: "mcp-secret" },
          enabled: true,
        },
      ];
      const mcpServerLookup = {
        getDecryptedForSession: vi.fn<McpServerLookup["getDecryptedForSession"]>(
          async () => servers
        ),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, mcpServerLookup } });

      expect(
        await f.context.loadMcpServers([{ ...SECONDARY, baseSha: "session-sha" }, PRIMARY])
      ).toBe(servers);
      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledExactlyOnceWith([
        { repoOwner: "Group/Subgroup", repoName: "API" },
        { repoOwner: PRIMARY.repoOwner, repoName: PRIMARY.repoName },
      ]);
      expect(f.logger.info.mock.calls).toEqual([
        ["MCP servers loaded", { event: "mcp.loaded", count: 2, names: ["local", "remote"] }],
      ]);
      expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("mcp-secret");
      expect(f.logger.warn).not.toHaveBeenCalled();
    });

    it("passes an empty scope for repo-less sessions and omits an empty server list", async () => {
      const mcpServerLookup = {
        getDecryptedForSession: vi.fn<McpServerLookup["getDecryptedForSession"]>(async () => []),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, mcpServerLookup } });

      expect(await f.context.loadMcpServers([])).toBeUndefined();
      expect(mcpServerLookup.getDecryptedForSession).toHaveBeenCalledExactlyOnceWith([]);
      expect(f.logger.info).toHaveBeenCalledWith("MCP servers loaded", {
        event: "mcp.loaded",
        count: 0,
        names: [],
      });
    });

    it("omits MCP servers without consulting the logger when no lookup is configured", async () => {
      const f = fixture();

      expect(await f.context.loadMcpServers([PRIMARY])).toBeUndefined();
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("omits servers on lookup failure and logs no private error metadata", async () => {
      const error = Object.assign(new Error("credential lookup unavailable"), {
        credentials: "mcp-secret",
      });
      const mcpServerLookup = {
        getDecryptedForSession: vi
          .fn<McpServerLookup["getDecryptedForSession"]>()
          .mockRejectedValue(error),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, mcpServerLookup } });

      expect(await f.context.loadMcpServers([PRIMARY])).toBeUndefined();
      expect(f.logger.warn.mock.calls).toEqual([
        [
          "Failed to load MCP servers",
          { event: "mcp.load_failed", error: "Error: credential lookup unavailable" },
        ],
      ]);
      expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("mcp-secret");
      expect(f.logger.info).not.toHaveBeenCalled();
    });
  });

  describe("resolveAgentSlackNotifyEnabled", () => {
    it.each([true, false])("forwards the repository-scoped gate result %s", async (enabled) => {
      const slackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn<SlackAgentNotifyLookup["isEnabledForRepo"]>(async () => enabled),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, slackAgentNotifyLookup } });

      expect(await f.context.resolveAgentSlackNotifyEnabled(createMockSession())).toBe(enabled);
      expect(slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledExactlyOnceWith(
        PRIMARY.repoOwner,
        PRIMARY.repoName
      );
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("defaults to disabled when the lookup is missing", async () => {
      const f = fixture();

      expect(await f.context.resolveAgentSlackNotifyEnabled(createMockSession())).toBe(false);
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("uses the global gate for repo-less sessions", async () => {
      const slackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn<SlackAgentNotifyLookup["isEnabledForRepo"]>(async () => true),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, slackAgentNotifyLookup } });

      expect(
        await f.context.resolveAgentSlackNotifyEnabled(
          createMockSession({ repo_owner: null, repo_name: null })
        )
      ).toBe(true);
      expect(slackAgentNotifyLookup.isEnabledForRepo).toHaveBeenCalledExactlyOnceWith(null, null);
    });

    it("disables notifications and warns when the lookup throws", async () => {
      const slackAgentNotifyLookup = {
        isEnabledForRepo: vi
          .fn<SlackAgentNotifyLookup["isEnabledForRepo"]>()
          .mockRejectedValue(new Error("gate unavailable")),
      };
      const f = fixture({ config: { model: CONFIGURED_MODEL, slackAgentNotifyLookup } });

      expect(await f.context.resolveAgentSlackNotifyEnabled(createMockSession())).toBe(false);
      expect(f.logger.warn).toHaveBeenCalledWith(
        "Failed to resolve agent slack-notify gate; treating as disabled",
        { event: "slack_notify.gate_resolve_failed", error: "gate unavailable" }
      );
    });
  });

  describe("resolveSandboxSettings", () => {
    it("returns empty settings without logging when no settings are stored", () => {
      const f = fixture();

      expect(f.context.resolveSandboxSettings(createMockSession())).toEqual({
        sandboxSettings: {},
        timeoutSeconds: undefined,
      });
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("parses valid settings, including an explicit provider-default resource", () => {
      const f = fixture();
      const settings = {
        sandboxTimeoutMs: 3_600_000,
        cpuCores: 2,
        memoryMib: null,
        terminalEnabled: true,
        tunnelPorts: [3000],
      };

      expect(
        f.context.resolveSandboxSettings(
          createMockSession({ sandbox_settings: JSON.stringify(settings) })
        )
      ).toEqual({ sandboxSettings: settings, timeoutSeconds: 3600 });
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("falls back to defaults and warns for invalid JSON without logging the stored blob", () => {
      const f = fixture();

      expect(
        f.context.resolveSandboxSettings(
          createMockSession({ sandbox_settings: "invalid-private-blob" })
        )
      ).toEqual({ sandboxSettings: {}, timeoutSeconds: undefined });
      expect(f.logger.warn.mock.calls).toEqual([
        ["Failed to parse sandbox_settings, using defaults"],
      ]);
    });

    it("omits invalid individual settings while keeping valid values", () => {
      const f = fixture();

      expect(
        f.context.resolveSandboxSettings(
          createMockSession({
            sandbox_settings: JSON.stringify({
              sandboxTimeoutMs: 999,
              cpuCores: -2,
              memoryMib: 0,
              terminalEnabled: "yes",
              tunnelPorts: ["bad", 3000],
              maxTotalChildSessions: 8,
            }),
          })
        )
      ).toEqual({
        sandboxSettings: { tunnelPorts: [3000], maxTotalChildSessions: 8 },
        timeoutSeconds: undefined,
      });
      expect(f.getLogger).not.toHaveBeenCalled();
    });

    it("drops unsupported provider settings before timeout conversion and warns with their names only", () => {
      const f = fixture({
        provider: { name: "daytona", capabilities: { supportsSandboxTimeout: false } },
      });

      expect(
        f.context.resolveSandboxSettings(
          createMockSession({
            sandbox_settings: JSON.stringify({
              cpuCores: 2,
              memoryMib: 4096,
              sandboxTimeoutMs: 3_600_000,
              terminalEnabled: true,
              buildTimeoutSeconds: 2400,
            }),
          })
        )
      ).toEqual({
        sandboxSettings: { terminalEnabled: true, buildTimeoutSeconds: 2400 },
        timeoutSeconds: undefined,
      });
      expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
        "Ignoring persisted sandbox settings unsupported by the provider",
        {
          event: "sandbox.settings_unsupported",
          provider: "daytona",
          settings: ["cpuCores", "memoryMib", "sandboxTimeoutMs"],
        }
      );
    });

    it.each([true, false])(
      "leaves an absent timeout undefined with capability %s",
      (supportsSandboxTimeout) => {
        const f = fixture({
          provider: { name: "test-provider", capabilities: { supportsSandboxTimeout } },
        });

        expect(f.context.resolveSandboxSettings(createMockSession())).toEqual({
          sandboxSettings: {},
          timeoutSeconds: undefined,
        });
        expect(f.getLogger).not.toHaveBeenCalled();
      }
    );

    it("converts an explicit timeout from milliseconds to seconds", () => {
      const { context } = fixture();

      expect(
        context.resolveSandboxSettings(
          createMockSession({ sandbox_settings: '{"sandboxTimeoutMs":3661000}' })
        )
      ).toEqual({ sandboxSettings: { sandboxTimeoutMs: 3_661_000 }, timeoutSeconds: 3661 });
    });

    it("raises a permanent provider error for an explicit unsupported timeout", () => {
      const { context } = fixture({
        provider: { name: "test-provider", capabilities: { supportsSandboxTimeout: false } },
      });
      const resolve = () =>
        context.resolveSandboxSettings(
          createMockSession({ sandbox_settings: '{"sandboxTimeoutMs":3600000}' })
        );

      expect(resolve).toThrow(SandboxProviderError);
      expect(resolve).toThrow(
        expect.objectContaining({
          errorType: "permanent",
          message: "test-provider does not support configurable sandbox timeouts",
        })
      );
    });
  });
});
