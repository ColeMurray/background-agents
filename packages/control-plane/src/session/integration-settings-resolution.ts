import { type CodeServerSettings, type SandboxSettings } from "@open-inspect/shared";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { createLogger } from "../logger";

const logger = createLogger("session-integration-settings");

/**
 * Resolve whether code-server should be enabled for a given repo,
 * checking both the `enabled` setting and the `enabledRepos` allowlist.
 */
export async function resolveCodeServerEnabled(
  db: D1Database | undefined,
  repoOwner: string | null,
  repoName: string | null
): Promise<boolean> {
  if (!db) return false;
  if (!repoOwner || !repoName) return false;
  const repo = `${repoOwner}/${repoName}`;
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig("code-server", repo);
    const codeServerSettings = settings as CodeServerSettings;
    if (codeServerSettings.enabled !== true) return false;
    // enabledRepos: null -> all repos, [] -> none, [...] -> allowlist
    if (enabledRepos !== null && !enabledRepos.includes(repo.toLowerCase())) return false;
    return true;
  } catch (e) {
    logger.warn("Failed to resolve code-server integration settings, defaulting to disabled", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Resolve sandbox settings for a given repo, merging global defaults with per-repo overrides.
 */
export async function resolveSandboxSettings(
  db: D1Database | undefined,
  repoOwner: string | null,
  repoName: string | null
): Promise<SandboxSettings> {
  if (!db) return {};
  if (!repoOwner || !repoName) {
    try {
      const store = new IntegrationSettingsStore(db);
      const globalSettings = await store.getGlobal("sandbox");
      return (globalSettings?.defaults ?? {}) as SandboxSettings;
    } catch (e) {
      logger.warn("Failed to resolve global sandbox settings, using defaults", {
        error: e instanceof Error ? e.message : String(e),
      });
      return {};
    }
  }
  const repo = `${repoOwner}/${repoName}`;
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig("sandbox", repo);
    // enabledRepos: null -> all repos, [] -> none, [...] -> allowlist
    if (enabledRepos !== null && !enabledRepos.includes(repo.toLowerCase())) return {};
    return settings as SandboxSettings;
  } catch (e) {
    logger.warn("Failed to resolve sandbox settings, using defaults", {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}
