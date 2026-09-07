import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { McpServerConfig, SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { Logger } from "../../logger";
import type { SessionRow } from "../../session/types";
import {
  SandboxProviderError,
  type SandboxLaunchInputs,
  type SessionRepositoryInfo,
} from "../provider";
import { parsePersistedSandboxSettings } from "../settings";

export interface LaunchInputContext {
  /**
   * Get the session's member repositories in position order. Pre-list
   * sessions get a one-entry list synthesized from the scalar columns
   * (buildSessionRepositories owns the rule); empty only for repo-less sessions.
   */
  getSessionRepositories(): SessionRepositoryInfo[];
  /** Get user env vars for sandbox injection */
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
}

/**
 * Lookup of MCP servers matching any member repository, without direct D1 dependencies.
 * Receives an empty repository list for repo-less sessions.
 */
export interface McpServerLookup {
  getDecryptedForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>
  ): Promise<McpServerConfig[]>;
}

/** Resolve the repository or global no-repository gate; false or throwing omits the tool. */
export interface SlackAgentNotifyLookup {
  isEnabledForRepo(repoOwner: string | null, repoName: string | null): Promise<boolean>;
}

export interface LaunchInputConfig {
  controlPlaneUrl: string;
  /** Default model ID used when the session has no model override. */
  model: string;
  /** MCP server lookup for injecting servers into sandboxes. */
  mcpServerLookup?: McpServerLookup;
  /** Resolves the launch-time agent-slack-notify gate. */
  slackAgentNotifyLookup?: SlackAgentNotifyLookup;
}

interface TimeoutProvider {
  readonly name: string;
  readonly capabilities: { supportsSandboxTimeout: boolean };
}

type LaunchSession = Pick<
  SessionRow,
  | "id"
  | "session_name"
  | "model"
  | "repo_owner"
  | "repo_name"
  | "base_branch"
  | "code_server_enabled"
  | "vnc_enabled"
  | "sandbox_settings"
>;

/** Resolve once per launch; image retries reuse these inputs with a new identity. */
export async function resolveLaunchInputs(
  session: LaunchSession,
  sessionContext: LaunchInputContext,
  config: LaunchInputConfig,
  sandboxProvider: TimeoutProvider,
  log: Logger
) {
  const { provider, model } = extractProviderAndModel(session.model || config.model);
  const repositories = sessionContext.getSessionRepositories();
  const [userEnvVars, mcpServers, agentSlackNotifyEnabled] = await Promise.all([
    sessionContext.getUserEnvVars(),
    resolveMcpServers(repositories, config.mcpServerLookup, log),
    resolveSlackNotify(session, config.slackAgentNotifyLookup, log),
  ]);

  const sandboxSettings = parseSandboxSettings(session, log);
  const inputs: SandboxLaunchInputs = {
    repoOwner: session.repo_owner,
    repoName: session.repo_name,
    controlPlaneUrl: config.controlPlaneUrl,
    provider,
    model,
    userEnvVars,
    timeoutSeconds: resolveSandboxTimeoutSeconds(sandboxSettings, sandboxProvider),
    branch: session.base_branch,
    codeServerEnabled: session.code_server_enabled === 1,
    vncEnabled: session.vnc_enabled === 1,
    agentSlackNotifyEnabled,
    mcpServers,
    sandboxSettings,
    // Keep the scalar wire form for unpinned single-repo and repo-less sessions.
    ...(repositories.length > 1 || repositories.some((repository) => repository.baseSha)
      ? { repositories }
      : {}),
  };
  return { sessionId: session.session_name || session.id, repositories, inputs };
}

async function resolveMcpServers(
  repositories: SessionRepositoryInfo[],
  lookup: McpServerLookup | undefined,
  log: Logger
): Promise<McpServerConfig[] | undefined> {
  try {
    if (lookup) {
      const servers = await lookup.getDecryptedForSession(
        repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
      );
      log.info("MCP servers loaded", {
        event: "mcp.loaded",
        count: servers?.length ?? 0,
        names: servers?.map((s) => s.name) ?? [],
      });
      return servers?.length ? servers : undefined;
    }
  } catch (err) {
    log.warn("Failed to load MCP servers", {
      event: "mcp.load_failed",
      error: String(err),
    });
  }
}

async function resolveSlackNotify(
  session: Pick<SessionRow, "repo_owner" | "repo_name">,
  lookup: SlackAgentNotifyLookup | undefined,
  log: Logger
): Promise<boolean> {
  try {
    if (lookup) {
      const hasRepository = Boolean(session.repo_owner && session.repo_name);
      return await lookup.isEnabledForRepo(
        hasRepository ? session.repo_owner : null,
        hasRepository ? session.repo_name : null
      );
    }
  } catch (err) {
    log.warn("Failed to resolve agent slack-notify gate; treating as disabled", {
      event: "slack_notify.gate_resolve_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return false;
}

export function parseSandboxSettings(
  session: Pick<SessionRow, "sandbox_settings">,
  log: Logger
): SandboxSettings {
  try {
    return parsePersistedSandboxSettings(session.sandbox_settings);
  } catch {
    log.warn("Failed to parse sandbox_settings, using defaults");
    return {};
  }
}

export function resolveSandboxTimeoutSeconds(
  sandboxSettings: SandboxSettings,
  provider: TimeoutProvider
): number | undefined {
  if (!provider.capabilities.supportsSandboxTimeout) {
    if (sandboxSettings.sandboxTimeoutMs !== undefined) {
      throw new SandboxProviderError(
        `${provider.name} does not support configurable sandbox timeouts`,
        "permanent"
      );
    }
    return undefined;
  }
  const timeoutMs = sandboxSettings.sandboxTimeoutMs;
  return timeoutMs === undefined ? undefined : timeoutMs / 1000;
}
