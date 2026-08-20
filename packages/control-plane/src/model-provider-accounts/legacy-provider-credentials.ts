import type { SqlDatabase } from "../db/sql-database";
import type { LegacyProviderKeyLocation } from "@open-inspect/shared/types/provider-accounts";

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
  scope_name: string | null;
  key: string;
}

export async function listLegacyProviderCredentials(
  db: SqlDatabase
): Promise<LegacyProviderKeyLocation[]> {
  const placeholders = LEGACY_KEYS.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT 'global' AS scope, NULL AS scope_id, NULL AS scope_name, key
         FROM global_secrets WHERE key IN (${placeholders})
         UNION ALL
         SELECT 'repository', CAST(repo_id AS TEXT), repo_owner || '/' || repo_name, key
         FROM repo_secrets WHERE key IN (${placeholders})
         UNION ALL
         SELECT 'environment', environment_id, NULL, key
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
        scopeId: row.scope_id!,
        repository: row.scope_name!,
        key: row.key,
      };
    }
    return { scope: "environment", scopeId: row.scope_id!, key: row.key };
  });
}
