import { type CodeServerSettings, type SandboxSettings } from "@open-inspect/shared";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { createLogger } from "../logger";
import type { RepoIdentity } from "./repository-target";
import type { SqlDatabase } from "../db/sql-database";

const logger = createLogger("session-integration-settings");

/**
 * Resolve whether code-server should be enabled for a given repo,
 * checking both the `enabled` setting and the `enabledRepos` allowlist.
 * `environmentId` layers that environment's override on top (design §13.5);
 * the allowlist stays evaluated against the repo.
 */
export async function resolveCodeServerEnabled(
  db: SqlDatabase | undefined,
  repoOwner: string | null,
  repoName: string | null,
  environmentId?: string | null
): Promise<boolean> {
  if (!db) return false;
  if (!repoOwner || !repoName) return false;
  const repo = `${repoOwner}/${repoName}`;
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig(
      "code-server",
      repo,
      environmentId
    );
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
 * Resolve sandbox settings for a given repo, merging global defaults with
 * per-repo overrides. `environmentId` layers that environment's override on
 * top (design §13.5); the `enabledRepos` allowlist stays evaluated against
 * the repo.
 */
export async function resolveSandboxSettings(
  db: SqlDatabase | undefined,
  repoOwner: string | null,
  repoName: string | null,
  environmentId?: string | null
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
    const { enabledRepos, settings } = await store.getResolvedConfig(
      "sandbox",
      repo,
      environmentId
    );
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

/**
 * The integration settings scoped to the whole session, resolved from its
 * primary member plus any environment-level overrides.
 */
export interface SessionScopedSettings {
  codeServerEnabled: boolean;
  sandboxSettings: SandboxSettings;
}

/**
 * Resolve the integration settings scoped to the whole session — as opposed to
 * bot- or trigger-scoped — from its member list.
 *
 * Per-feature scope rules (design §6.2), stated here in one place so callers
 * stop re-deriving them from the scalar mirror:
 *
 * - **Sandbox settings, code-server enablement, and the Slack agent-notify gate
 *   resolve from the PRIMARY member** (the ordinal-0 mirror). These configure
 *   sandbox-wide singletons or are gating booleans, where an any-member-wins
 *   union would let one member silently override another member owner's
 *   explicit opt-out; `enabledRepos` allowlists are likewise evaluated against
 *   the primary. The Slack gate is resolved live at spawn from the scalar mirror
 *   (`resolveAgentSlackNotifyEnabled`) — the same rule on a different call path.
 * - **MCP servers resolve as the UNION across members** (injecting a server
 *   scoped to any member is additive and side-effect-free) — resolved
 *   separately in `McpServerStore.getDecryptedForSession`.
 * - **Environment-level overrides are the TOP layer** (design §13.5): when the
 *   session launches from a saved environment, that environment's sandbox and
 *   code-server overrides win over the primary member's; unset keys keep
 *   inheriting from the primary/global layers, and `enabledRepos` allowlists
 *   stay evaluated against the primary.
 *
 * Members are in position order; index 0 is the primary. An empty list (a
 * repo-less session) falls back to global defaults, matching the underlying
 * resolvers' null-repo behavior.
 */
export async function resolveSessionScopedSettings(
  db: SqlDatabase | undefined,
  members: readonly RepoIdentity[],
  environmentId?: string | null
): Promise<SessionScopedSettings> {
  const primary = members[0] ?? null;
  const [codeServerEnabled, sandboxSettings] = await Promise.all([
    resolveCodeServerEnabled(
      db,
      primary?.repoOwner ?? null,
      primary?.repoName ?? null,
      environmentId
    ),
    resolveSandboxSettings(
      db,
      primary?.repoOwner ?? null,
      primary?.repoName ?? null,
      environmentId
    ),
  ]);
  return { codeServerEnabled, sandboxSettings };
}
