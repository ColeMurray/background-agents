import type { AvailableAgent } from "@open-inspect/shared";

interface RepoAgentCacheRow {
  repo_owner: string;
  repo_name: string;
  branch: string;
  agents_json: string;
  created_at: number;
  updated_at: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function parseAgents(value: string): AvailableAgent[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (agent): agent is AvailableAgent =>
        typeof agent === "object" &&
        agent !== null &&
        typeof (agent as AvailableAgent).name === "string"
    );
  } catch {
    return [];
  }
}

export class RepoAgentCacheStore {
  constructor(private readonly db: D1Database) {}

  async get(owner: string, name: string, branch: string): Promise<AvailableAgent[] | null> {
    const row = await this.db
      .prepare(
        "SELECT agents_json FROM repo_agent_cache WHERE repo_owner = ? AND repo_name = ? AND branch = ?"
      )
      .bind(normalize(owner), normalize(name), branch)
      .first<Pick<RepoAgentCacheRow, "agents_json">>();

    return row ? parseAgents(row.agents_json) : null;
  }

  async upsert(
    owner: string,
    name: string,
    branch: string,
    agents: AvailableAgent[]
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repo_agent_cache (repo_owner, repo_name, branch, agents_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name, branch) DO UPDATE SET
           agents_json = excluded.agents_json,
           updated_at = excluded.updated_at`
      )
      .bind(normalize(owner), normalize(name), branch, JSON.stringify(agents), now, now)
      .run();
  }
}
