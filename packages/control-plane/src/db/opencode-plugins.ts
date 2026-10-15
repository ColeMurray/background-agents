import {
  opencodePluginSchema,
  type OpencodePlugin,
  type OpencodePluginInput,
  type OpencodePluginUpdate,
} from "@open-inspect/shared/types/opencode-plugins";
import type { SqlDatabase } from "./sql-database";

interface PluginRow {
  id: string;
  revision: number;
  spec: string;
  repo_scope: string | null;
  enabled: number;
}

export class OpencodePluginConflictError extends Error {}

function rowToPlugin(row: PluginRow): OpencodePlugin {
  return opencodePluginSchema.parse({
    id: row.id,
    revision: row.revision,
    spec: row.spec,
    repoScopes: row.repo_scope === null ? null : JSON.parse(row.repo_scope),
    enabled: row.enabled === 1,
  });
}

export class OpencodePluginStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<OpencodePlugin[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM opencode_plugins ORDER BY spec")
      .all<PluginRow>();
    return results.map(rowToPlugin);
  }

  async create(input: OpencodePluginInput): Promise<OpencodePlugin> {
    const plugin = { ...input, id: crypto.randomUUID(), revision: 1 };
    await this.db
      .prepare("INSERT INTO opencode_plugins (id, spec, repo_scope, enabled) VALUES (?, ?, ?, ?)")
      .bind(
        plugin.id,
        plugin.spec,
        input.repoScopes === null ? null : JSON.stringify(input.repoScopes),
        input.enabled ? 1 : 0
      )
      .run();
    return plugin;
  }

  async update(id: string, input: OpencodePluginUpdate): Promise<OpencodePlugin | null> {
    const statement =
      "revision" in input
        ? this.db
            .prepare(
              "UPDATE opencode_plugins SET spec = ?, repo_scope = ?, enabled = ?, revision = revision + 1 WHERE id = ? AND revision = ? RETURNING *"
            )
            .bind(
              input.spec,
              input.repoScopes === null ? null : JSON.stringify(input.repoScopes),
              input.enabled ? 1 : 0,
              id,
              input.revision
            )
        : this.db
            .prepare(
              "UPDATE opencode_plugins SET enabled = ?, revision = revision + 1 WHERE id = ? RETURNING *"
            )
            .bind(input.enabled ? 1 : 0, id);
    const row = await statement.first<PluginRow>();
    if (row) return rowToPlugin(row);
    if (await this.db.prepare("SELECT id FROM opencode_plugins WHERE id = ?").bind(id).first()) {
      throw new OpencodePluginConflictError(
        "Plugin changed. Reload the catalog before editing again."
      );
    }
    return null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM opencode_plugins WHERE id = ?")
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /** Match any session member; repo-less sessions receive only global plugins. */
  async forSession(
    repositories: readonly { repoOwner: string; repoName: string }[]
  ): Promise<string[]> {
    const names = new Set(
      repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
    );
    return (await this.list())
      .filter(
        (plugin) =>
          plugin.enabled &&
          (plugin.repoScopes === null || plugin.repoScopes.some((scope) => names.has(scope)))
      )
      .map((plugin) => plugin.spec);
  }
}
