import type { RepoMetadata } from "@open-inspect/shared";

/** D1 batch() supports at most 100 statements per call. */
const D1_BATCH_LIMIT = 100;

interface RepoMetadataRow {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toMetadata(row: RepoMetadataRow): RepoMetadata {
  const metadata: RepoMetadata = {};
  if (row.description != null) metadata.description = row.description;
  const aliases = parseJsonArray(row.aliases);
  if (aliases) metadata.aliases = aliases;
  const channelAssociations = parseJsonArray(row.channel_associations);
  if (channelAssociations) metadata.channelAssociations = channelAssociations;
  const keywords = parseJsonArray(row.keywords);
  if (keywords) metadata.keywords = keywords;
  return metadata;
}

export class RepoMetadataStore {
  constructor(private readonly db: D1Database) {}

  async get(owner: string, name: string): Promise<RepoMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?")
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepoMetadataRow>();

    return row ? toMetadata(row) : null;
  }

  async upsert(owner: string, name: string, metadata: RepoMetadata): Promise<void> {
    const now = Date.now();
    const normalizedOwner = owner.toLowerCase();
    const normalizedName = name.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO repo_metadata (repo_owner, repo_name, description, aliases, channel_associations, keywords, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           description = excluded.description,
           aliases = excluded.aliases,
           channel_associations = excluded.channel_associations,
           keywords = excluded.keywords,
           updated_at = excluded.updated_at`
      )
      .bind(
        normalizedOwner,
        normalizedName,
        metadata.description ?? null,
        metadata.aliases ? JSON.stringify(metadata.aliases) : null,
        metadata.channelAssociations ? JSON.stringify(metadata.channelAssociations) : null,
        metadata.keywords ? JSON.stringify(metadata.keywords) : null,
        now,
        now
      )
      .run();
  }

  async getBatch(
    repos: Array<{ owner: string; name: string }>
  ): Promise<Map<string, RepoMetadata>> {
    if (repos.length === 0) return new Map();

    const map = new Map<string, RepoMetadata>();

    // D1 batch() has a per-call statement limit; chunk to stay within it.
    for (let start = 0; start < repos.length; start += D1_BATCH_LIMIT) {
      const chunk = repos.slice(start, start + D1_BATCH_LIMIT);

      const statements = chunk.map((repo) =>
        this.db
          .prepare("SELECT * FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?")
          .bind(repo.owner.toLowerCase(), repo.name.toLowerCase())
      );

      const results = await this.db.batch<RepoMetadataRow>(statements);

      for (let i = 0; i < chunk.length; i++) {
        const rows = results[i]?.results;
        if (rows && rows.length > 0) {
          const key = `${chunk[i].owner.toLowerCase()}/${chunk[i].name.toLowerCase()}`;
          map.set(key, toMetadata(rows[0]));
        }
      }
    }

    return map;
  }
}
