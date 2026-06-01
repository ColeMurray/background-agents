import { type CodeServerSettings, type SandboxSettings } from "@open-inspect/shared";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { createLogger } from "../logger";

const logger = createLogger("session-integration-settings");

type RepoRef = {
  repoOwner: string;
  repoName: string;
};

function repoSettingsKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

/**
 * Resolve whether code-server should be enabled for a given repo,
 * checking both the `enabled` setting and the `enabledRepos` allowlist.
 */
export async function resolveCodeServerEnabled(
  db: D1Database | undefined,
  repoOwner: string,
  repoName: string
): Promise<boolean> {
  if (!db) return false;
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
  repoOwner: string,
  repoName: string
): Promise<SandboxSettings> {
  if (!db) return {};
  const repo = repoSettingsKey(repoOwner, repoName);
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig("sandbox", repo);
    // enabledRepos: null -> all repos, [] -> none, [...] -> allowlist
    if (enabledRepos !== null && !enabledRepos.includes(repo)) return {};
    return settings as SandboxSettings;
  } catch (e) {
    logger.warn("Failed to resolve sandbox settings, using defaults", {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}

/**
 * Resolve sandbox settings for multiple repos with one global-settings read and one repo-settings
 * read. Returned settings are aligned with the input repos.
 */
export async function resolveSandboxSettingsForRepos(
  db: D1Database | undefined,
  repos: RepoRef[]
): Promise<SandboxSettings[]> {
  if (!db || repos.length === 0) return repos.map(() => ({}));

  try {
    const repoKeys = repos.map((repo) => repoSettingsKey(repo.repoOwner, repo.repoName));
    const store = new IntegrationSettingsStore(db);
    const configs = await store.getResolvedConfigs("sandbox", repoKeys);

    return repoKeys.map((repo) => {
      const config = configs.get(repo);
      if (!config) return {};
      if (config.enabledRepos !== null && !config.enabledRepos.includes(repo)) return {};
      return config.settings as SandboxSettings;
    });
  } catch (e) {
    logger.warn("Failed to resolve sandbox settings in batch, using defaults", {
      error: e instanceof Error ? e.message : String(e),
    });
    return repos.map(() => ({}));
  }
}
