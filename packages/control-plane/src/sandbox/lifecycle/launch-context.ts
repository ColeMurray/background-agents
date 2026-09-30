import { getValidHarnessOrDefault, type HarnessId } from "@open-inspect/shared/harnesses";
import { extractProviderAndModel, getValidModelOrDefault } from "@open-inspect/shared/models";
import {
  omitUnsupportedSandboxSettings,
  unsupportedSandboxSettings,
  type McpServerConfig,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { repoImageBuildScope, type ImageBuildScope } from "../../image-builds/model";
import type { Logger } from "../../logger";
import { sessionHasRepository, type SessionRow } from "../../session/types";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type SandboxProviderCapabilities,
  type SessionRepositoryInfo,
} from "../provider";
import { parsePersistedSandboxSettings } from "../settings";
import {
  evaluateImageBuildForSpawn,
  type ImageBuildLookup,
  type SelectedImageBuild,
} from "./image-selection";

export interface SandboxLaunchContextReader {
  /** Position-ordered members, including the scalar fallback for legacy sessions. */
  getSessionRepositories(): SessionRepositoryInfo[];
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
}

export interface McpServerLookup {
  /** A scoped server applies when any member matches; empty for repo-less sessions. */
  getDecryptedForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>
  ): Promise<McpServerConfig[]>;
}

export interface SlackAgentNotifyLookup {
  /** False or throwing disables the tool, including in the global repo-less scope. */
  isEnabledForRepo(repoOwner: string | null, repoName: string | null): Promise<boolean>;
}

export interface SandboxLaunchConfig {
  /** Default model when the session has no override. */
  model: string;
  mcpServerLookup?: McpServerLookup;
  slackAgentNotifyLookup?: SlackAgentNotifyLookup;
}

export interface SandboxLaunchContextDependencies {
  sessionContext: SandboxLaunchContextReader;
  provider: {
    name: string;
    capabilities: Pick<SandboxProviderCapabilities, "supportsSandboxTimeout">;
  };
  config: SandboxLaunchConfig;
  imageBuildLookup?: ImageBuildLookup;
  /** Construction can precede the session row; resolve log context only at use. */
  getLogger: () => Pick<Logger, "info" | "warn">;
}

export type AgentLaunchFields = Pick<CreateSandboxConfig, "harness" | "provider" | "model">;

export interface RepositoryLaunchInputs {
  repositories: SessionRepositoryInfo[];
  fields: Pick<CreateSandboxConfig, "repoOwner" | "repoName" | "branch" | "repositories">;
}

export interface ResolvedSandboxSettings {
  sandboxSettings: SandboxSettings;
  timeoutSeconds: number | undefined;
}

/** Input resolution only; startup mode, reservations and provider operations belong to the manager. */
export interface SandboxLaunchContext {
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
  resolveAgent(session: SessionRow): AgentLaunchFields;
  resolveRepositories(session: SessionRow): RepositoryLaunchInputs;
  lookupImageBuildForSpawn(
    scope: ImageBuildScope,
    repositories: SessionRepositoryInfo[],
    harness: HarnessId
  ): Promise<SelectedImageBuild | null>;
  markImageBuildRestoreFailed(image: SelectedImageBuild, error: unknown): Promise<void>;
  resolveAgentSlackNotifyEnabled(session: SessionRow): Promise<boolean>;
  loadMcpServers(repositories: SessionRepositoryInfo[]): Promise<McpServerConfig[] | undefined>;
  resolveSandboxSettings(session: SessionRow): ResolvedSandboxSettings;
}

/** Synchronous eligibility keeps ineligible sessions outside the image-lookup await. */
export function resolveImageBuildScope(
  session: SessionRow,
  repositories: SessionRepositoryInfo[]
): ImageBuildScope | null {
  // Environment misses never fall back to a repo image, which bakes different setup/secrets.
  if (session.environment_id) return { kind: "environment", id: session.environment_id };
  // Ad-hoc multi-repo sessions cannot use an image that bakes a single checkout.
  return sessionHasRepository(session) && repositories.length === 1
    ? repoImageBuildScope(repositories[0].repoOwner, repositories[0].repoName)
    : null;
}

/**
 * Stateless launch-input mechanics, with no reservation, admission, or provider I/O authority.
 * The manager calls each operation at its existing await point: fresh and restore intentionally
 * resolve integrations in different orders, while resume/bridge use only settings and timeouts.
 */
export function createSandboxLaunchContext({
  sessionContext,
  provider,
  config,
  imageBuildLookup,
  getLogger,
}: SandboxLaunchContextDependencies): SandboxLaunchContext {
  return {
    getUserEnvVars: () => sessionContext.getUserEnvVars(),

    resolveAgent(session: SessionRow): AgentLaunchFields {
      return {
        ...extractProviderAndModel(getValidModelOrDefault(session.model || config.model)),
        harness: getValidHarnessOrDefault(session.harness),
      };
    },

    resolveRepositories(session: SessionRow): RepositoryLaunchInputs {
      const repositories = sessionContext.getSessionRepositories();
      // Single-repo sessions keep the scalar wire form unless they carry a base SHA.
      const multiRepoFields: Pick<CreateSandboxConfig, "repositories"> =
        repositories.length > 1 || repositories.some((repository) => repository.baseSha)
          ? { repositories }
          : {};
      return {
        repositories,
        fields: {
          repoOwner: session.repo_owner,
          repoName: session.repo_name,
          branch: session.base_branch,
          ...multiRepoFields,
        },
      };
    },

    async lookupImageBuildForSpawn(
      scope: ImageBuildScope,
      repositories: SessionRepositoryInfo[],
      harness: HarnessId
    ): Promise<SelectedImageBuild | null> {
      if (!imageBuildLookup || repositories.length === 0) return null;
      try {
        const image = await imageBuildLookup.getLatestReady(scope);
        const result = await evaluateImageBuildForSpawn(image, repositories, harness);
        if (result.outcome === "selected") {
          getLogger().info("Using prebuilt image", {
            event: "image_build.spawn_selected",
            scope_kind: scope.kind,
            scope_id: scope.id,
            image_build_id: result.image.imageBuildId,
            runtime_version: result.image.runtimeVersion,
          });
          return result.image;
        }
        getLogger().info("Prebuilt image miss, using base image", {
          event: "image_build.spawn_miss",
          scope_kind: scope.kind,
          scope_id: scope.id,
          reason: result.reason,
          image_build_id: result.imageBuildId,
        });
        return null;
      } catch (e) {
        getLogger().warn("Failed to look up prebuilt image, using base image", {
          event: "image_build.spawn_miss",
          scope_kind: scope.kind,
          scope_id: scope.id,
          reason: "lookup_failed",
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    },

    /** Called only by the manager's confirmed-unavailable branch; retry must survive D1 failure. */
    async markImageBuildRestoreFailed(image: SelectedImageBuild, error: unknown): Promise<void> {
      if (!imageBuildLookup) return;
      try {
        await imageBuildLookup.markRestoreFailed(
          image.imageBuildId,
          `restore failed at spawn: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch (e) {
        getLogger().warn("Failed to mark prebuilt image restore-failed", {
          image_build_id: image.imageBuildId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    async resolveAgentSlackNotifyEnabled(session: SessionRow): Promise<boolean> {
      if (!config.slackAgentNotifyLookup) return false;
      try {
        return await config.slackAgentNotifyLookup.isEnabledForRepo(
          sessionHasRepository(session) ? session.repo_owner : null,
          sessionHasRepository(session) ? session.repo_name : null
        );
      } catch (err) {
        getLogger().warn("Failed to resolve agent slack-notify gate; treating as disabled", {
          event: "slack_notify.gate_resolve_failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    async loadMcpServers(
      repositories: SessionRepositoryInfo[]
    ): Promise<McpServerConfig[] | undefined> {
      try {
        if (!config.mcpServerLookup) return undefined;
        const servers = await config.mcpServerLookup.getDecryptedForSession(
          repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
        );
        getLogger().info("MCP servers loaded", {
          event: "mcp.loaded",
          count: servers?.length ?? 0,
          names: servers?.map((s) => s.name) ?? [],
        });
        return servers?.length ? servers : undefined;
      } catch (err) {
        getLogger().warn("Failed to load MCP servers", {
          event: "mcp.load_failed",
          error: String(err),
        });
        return undefined;
      }
    },

    resolveSandboxSettings(session: SessionRow): ResolvedSandboxSettings {
      let sandboxSettings: SandboxSettings;
      try {
        const settings = parsePersistedSandboxSettings(session.sandbox_settings);
        const unsupported = unsupportedSandboxSettings(settings, provider.name);
        if (unsupported.length > 0) {
          getLogger().warn("Ignoring persisted sandbox settings unsupported by the provider", {
            event: "sandbox.settings_unsupported",
            provider: provider.name,
            settings: unsupported,
          });
        }
        sandboxSettings = omitUnsupportedSandboxSettings(settings, provider.name);
      } catch {
        getLogger().warn("Failed to parse sandbox_settings, using defaults");
        sandboxSettings = {};
      }
      if (!provider.capabilities.supportsSandboxTimeout) {
        if (sandboxSettings.sandboxTimeoutMs !== undefined) {
          throw new SandboxProviderError(
            `${provider.name} does not support configurable sandbox timeouts`,
            "permanent"
          );
        }
        return { sandboxSettings, timeoutSeconds: undefined };
      }
      const timeoutMs = sandboxSettings.sandboxTimeoutMs;
      return {
        sandboxSettings,
        timeoutSeconds: timeoutMs === undefined ? undefined : timeoutMs / 1000,
      };
    },
  };
}
