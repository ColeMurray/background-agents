import type { SqlDatabase } from "../db/sql-database";
import type { LegacyProviderKeyLocation } from "@open-inspect/shared/types/provider-accounts";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";

const LEGACY_KEYS = [
  "OPENAI_OAUTH_REFRESH_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "OPENAI_OAUTH_ACCOUNT_ID",
  "XAI_OAUTH_REFRESH_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
] as const;

interface InventoryRow {
  scope: "global" | "repository" | "environment";
  scope_id: string | null;
  scope_owner: string | null;
  scope_repo_name: string | null;
  key: string;
}

function requireInventoryValue(value: string | null, field: string): string {
  if (value) return value;
  throw new Error(`Legacy provider credential inventory row is missing ${field}`);
}

export async function listLegacyProviderCredentials(
  db: SqlDatabase
): Promise<LegacyProviderKeyLocation[]> {
  const placeholders = LEGACY_KEYS.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT 'global' AS scope, NULL AS scope_id,
              NULL AS scope_owner, NULL AS scope_repo_name, key
         FROM global_secrets WHERE key IN (${placeholders})
         UNION ALL
         SELECT 'repository', CAST(repo_id AS TEXT), repo_owner, repo_name, key
         FROM repo_secrets WHERE key IN (${placeholders})
         UNION ALL
         SELECT 'environment', environment_id, NULL, NULL, key
         FROM environment_secrets WHERE key IN (${placeholders})
         ORDER BY scope, scope_id, key`
    )
    .bind(...LEGACY_KEYS, ...LEGACY_KEYS, ...LEGACY_KEYS)
    .all<InventoryRow>();
  return result.results.map((row) => {
    if (row.scope === "global") return { scope: "global", key: row.key };
    if (row.scope === "repository") {
      return {
        scope: "repository",
        scopeId: requireInventoryValue(row.scope_id, "repository scope ID"),
        repository: formatRepositoryFullName({
          repoOwner: requireInventoryValue(row.scope_owner, "repository owner"),
          repoName: requireInventoryValue(row.scope_repo_name, "repository name"),
        }),
        key: row.key,
      };
    }
    return {
      scope: "environment",
      scopeId: requireInventoryValue(row.scope_id, "environment scope ID"),
      key: row.key,
    };
  });
}
