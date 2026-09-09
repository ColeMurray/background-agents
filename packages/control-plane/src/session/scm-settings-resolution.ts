import type { ScmSettings } from "@open-inspect/shared/types/integrations";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { ScmSettingsStore } from "../db/scm-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { RepoIdentity } from "./repository-target";

/**
 * Resolves SCM settings (global defaults merged with the per-repo override) for
 * a pull request's target repository. Storage failures propagate to fail closed.
 */
export async function resolveScmSettings(
  db: SqlDatabase,
  repo: RepoIdentity
): Promise<ScmSettings> {
  const scmSettingsStore = new ScmSettingsStore(db);
  return scmSettingsStore.getResolvedSettings(formatRepositoryFullName(repo));
}
