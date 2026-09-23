/**
 * Session launch policy, independent of attempt reservation and provider I/O.
 * Hard prerequisites complete before independent best-effort integrations.
 * This is an ephemeral result, not an atomic cross-store snapshot or a secret cache.
 */
import { getValidHarnessOrDefault, type HarnessId } from "@open-inspect/shared/harnesses";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import {
  omitUnsupportedSandboxSettings,
  unsupportedSandboxSettings,
  type McpServerConfig,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { sessionHasRepository, type SessionRow } from "../../session/types";
import type { Logger } from "../../logger";
import { repoImageBuildScope, type ImageBuildScope } from "../../image-builds/model";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type SessionRepositoryInfo,
} from "../provider";
import { parsePersistedSandboxSettings } from "../settings";
import {
  evaluateImageBuildForSpawn,
  type ImageBuildLookup,
  type SelectedImageBuild,
} from "./image-selection";

export interface McpServerLookup {
  getDecryptedForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>
  ): Promise<McpServerConfig[]>;
}

export interface SlackAgentNotifyLookup {
  isEnabledForRepo(repoOwner: string | null, repoName: string | null): Promise<boolean>;
}

export interface LaunchInputContext {
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
  getSessionRepositories(): SessionRepositoryInfo[];
}

interface LaunchPolicyConfig {
  controlPlaneUrl: string;
  model: string;
  mcpServerLookup?: McpServerLookup;
  slackAgentNotifyLookup?: SlackAgentNotifyLookup;
}

type LaunchInputs = Omit<
  CreateSandboxConfig,
  "sandboxId" | "sandboxAuthToken" | "prebuiltImageId" | "prebuiltImageSha"
>;

export class LaunchPolicyResolver {
  constructor(
    private readonly sessionContext: LaunchInputContext,
    private readonly provider: Pick<SandboxProvider, "name" | "capabilities">,
    private readonly config: LaunchPolicyConfig,
    private readonly imageBuildLookup: ImageBuildLookup | undefined,
    private readonly log: Logger
  ) {}

  async resolve(
    session: SessionRow,
    mode: "fresh" | "restore"
  ): Promise<{
    inputs: LaunchInputs;
    selectedImage: SelectedImageBuild | null;
  }> {
    // The existing resolver deliberately reads current secrets using persisted
    // auth bindings; passing a SessionRow here does not make those reads atomic.
    const userEnvVars = await this.sessionContext.getUserEnvVars();
    const { provider, model } = extractProviderAndModel(session.model || this.config.model);
    const repositories = this.sessionContext.getSessionRepositories();
    const harness = getValidHarnessOrDefault(session.harness);
    let selectedImage: SelectedImageBuild | null = null;
    if (mode === "fresh") {
      // Environment images never fall back to repo-scoped images. Multi-repo
      // ad-hoc launches use base; image invalidation/retry remain in the manager.
      if (session.environment_id) {
        selectedImage = await this.lookupImageBuildForSpawn(
          { kind: "environment", id: session.environment_id },
          repositories,
          harness
        );
      } else if (sessionHasRepository(session) && repositories.length === 1) {
        selectedImage = await this.lookupImageBuildForSpawn(
          repoImageBuildScope(repositories[0].repoOwner, repositories[0].repoName),
          repositories,
          harness
        );
      }
    }
    // Neither integration reads or writes the other's state; each owns its
    // degradation behavior. Keep hard prerequisites outside this concurrency.
    const [mcpServers, agentSlackNotifyEnabled] = await Promise.all([
      this.loadMcpServers(repositories),
      this.resolveAgentSlackNotifyEnabled(session),
    ]);
    const { sandboxSettings, timeoutSeconds } = this.resolveSettings(session);
    return {
      selectedImage,
      inputs: {
        sessionId: session.session_name || session.id,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        controlPlaneUrl: this.config.controlPlaneUrl,
        harness,
        provider,
        model,
        userEnvVars,
        branch: session.base_branch,
        codeServerEnabled: session.code_server_enabled === 1,
        vncEnabled: session.vnc_enabled === 1,
        agentSlackNotifyEnabled,
        mcpServers,
        sandboxSettings,
        timeoutSeconds,
        // Preserve the scalar form, except pinned helper and multi-repo launches.
        ...(repositories.length > 1 || repositories.some((repo) => repo.baseSha)
          ? { repositories }
          : {}),
      },
    };
  }

  /** Resume needs settings only; it must not resolve new runtime inputs. */
  resolveSettings(session: SessionRow): {
    sandboxSettings: SandboxSettings;
    timeoutSeconds: number | undefined;
  } {
    const sandboxSettings = this.parseSandboxSettings(session);
    return { sandboxSettings, timeoutSeconds: this.resolveSandboxTimeoutSeconds(sandboxSettings) };
  }

  private async lookupImageBuildForSpawn(
    scope: ImageBuildScope,
    repositories: SessionRepositoryInfo[],
    harness: HarnessId
  ): Promise<SelectedImageBuild | null> {
    if (!this.imageBuildLookup || repositories.length === 0) return null;
    try {
      const image = await this.imageBuildLookup.getLatestReady(scope);
      const result = await evaluateImageBuildForSpawn(image, repositories, harness);
      if (result.outcome === "selected") {
        this.log.info("Using prebuilt image", {
          event: "image_build.spawn_selected",
          scope_kind: scope.kind,
          scope_id: scope.id,
          image_build_id: result.image.imageBuildId,
          runtime_version: result.image.runtimeVersion,
        });
        return result.image;
      }
      this.log.info("Prebuilt image miss, using base image", {
        event: "image_build.spawn_miss",
        scope_kind: scope.kind,
        scope_id: scope.id,
        reason: result.reason,
        image_build_id: result.imageBuildId,
      });
      return null;
    } catch (e) {
      this.log.warn("Failed to look up prebuilt image, using base image", {
        event: "image_build.spawn_miss",
        scope_kind: scope.kind,
        scope_id: scope.id,
        reason: "lookup_failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async resolveAgentSlackNotifyEnabled(session: SessionRow): Promise<boolean> {
    if (!this.config.slackAgentNotifyLookup) return false;
    try {
      return await this.config.slackAgentNotifyLookup.isEnabledForRepo(
        sessionHasRepository(session) ? session.repo_owner : null,
        sessionHasRepository(session) ? session.repo_name : null
      );
    } catch (err) {
      this.log.warn("Failed to resolve agent slack-notify gate; treating as disabled", {
        event: "slack_notify.gate_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Load MCP servers applicable to the current session's repository.
   * Returns undefined if none are found or DB is not configured.
   */
  private async loadMcpServers(
    repositories: SessionRepositoryInfo[]
  ): Promise<McpServerConfig[] | undefined> {
    try {
      if (!this.config.mcpServerLookup) return undefined;
      const servers = await this.config.mcpServerLookup.getDecryptedForSession(
        repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
      );
      this.log.info("MCP servers loaded", {
        event: "mcp.loaded",
        count: servers?.length ?? 0,
        names: servers?.map((s) => s.name) ?? [],
      });
      return servers?.length ? servers : undefined;
    } catch (err) {
      this.log.warn("Failed to load MCP servers", {
        event: "mcp.load_failed",
        error: String(err),
      });
      return undefined;
    }
  }

  private parseSandboxSettings(session: SessionRow): SandboxSettings {
    try {
      const settings = parsePersistedSandboxSettings(session.sandbox_settings);
      const unsupported = unsupportedSandboxSettings(settings, this.provider.name);
      if (unsupported.length > 0) {
        this.log.warn("Ignoring persisted sandbox settings unsupported by the provider", {
          event: "sandbox.settings_unsupported",
          provider: this.provider.name,
          settings: unsupported,
        });
      }
      return omitUnsupportedSandboxSettings(settings, this.provider.name);
    } catch {
      this.log.warn("Failed to parse sandbox_settings, using defaults");
      return {};
    }
  }

  private resolveSandboxTimeoutSeconds(sandboxSettings: SandboxSettings): number | undefined {
    if (!this.provider.capabilities.supportsSandboxTimeout) {
      if (sandboxSettings.sandboxTimeoutMs !== undefined) {
        throw new SandboxProviderError(
          `${this.provider.name} does not support configurable sandbox timeouts`,
          "permanent"
        );
      }
      return undefined;
    }
    const timeoutMs = sandboxSettings.sandboxTimeoutMs;
    return timeoutMs === undefined ? undefined : timeoutMs / 1000;
  }
}
