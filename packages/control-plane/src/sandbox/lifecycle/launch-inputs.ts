import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { McpServerConfig, SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { Logger } from "../../logger";
import { sessionHasRepository, type SessionRow } from "../../session/types";
import { SandboxProviderError, type RestoreConfig, type SandboxProvider } from "../provider";
import { parsePersistedSandboxSettings } from "../settings";
import type { SandboxLifecycleConfig, SessionContextReader } from "./manager";

/** Resolve once per launch; image retries reuse these inputs with a new identity. */
export async function resolveLaunchInputs(
  session: SessionRow,
  sessionContext: SessionContextReader,
  config: Pick<
    SandboxLifecycleConfig,
    "model" | "controlPlaneUrl" | "mcpServerLookup" | "slackAgentNotifyLookup"
  >,
  sandboxProvider: SandboxProvider,
  log: Logger
) {
  const userEnvVars = await sessionContext.getUserEnvVars();
  const { provider, model } = extractProviderAndModel(session.model || config.model);
  const repositories = sessionContext.getSessionRepositories();

  let mcpServers: McpServerConfig[] | undefined;
  try {
    if (config.mcpServerLookup) {
      const servers = await config.mcpServerLookup.getDecryptedForSession(
        repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
      );
      log.info("MCP servers loaded", {
        event: "mcp.loaded",
        count: servers?.length ?? 0,
        names: servers?.map((s) => s.name) ?? [],
      });
      mcpServers = servers?.length ? servers : undefined;
    }
  } catch (err) {
    log.warn("Failed to load MCP servers", {
      event: "mcp.load_failed",
      error: String(err),
    });
  }

  let agentSlackNotifyEnabled = false;
  try {
    if (config.slackAgentNotifyLookup) {
      agentSlackNotifyEnabled = await config.slackAgentNotifyLookup.isEnabledForRepo(
        sessionHasRepository(session) ? session.repo_owner : null,
        sessionHasRepository(session) ? session.repo_name : null
      );
    }
  } catch (err) {
    log.warn("Failed to resolve agent slack-notify gate; treating as disabled", {
      event: "slack_notify.gate_resolve_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sandboxSettings = parseSandboxSettings(session, log);
  const inputs: Omit<RestoreConfig, "snapshotImageId" | "sandboxId" | "sandboxAuthToken"> = {
    sessionId: session.session_name || session.id,
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
  return { repositories, inputs };
}

export function parseSandboxSettings(session: SessionRow, log: Logger): SandboxSettings {
  try {
    return parsePersistedSandboxSettings(session.sandbox_settings);
  } catch {
    log.warn("Failed to parse sandbox_settings, using defaults");
    return {};
  }
}

export function resolveSandboxTimeoutSeconds(
  sandboxSettings: SandboxSettings,
  provider: SandboxProvider
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
