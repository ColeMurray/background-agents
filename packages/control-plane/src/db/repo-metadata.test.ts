import { beforeEach, describe, expect, it } from "vitest";
import { RepoMetadataStore } from "./repo-metadata";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";

type RepoMetadataRow = {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  default_environment_id: string | null;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  SELECT_BY_PK: /^SELECT \* FROM repo_metadata WHERE repo_owner = \? AND repo_name = \?$/,
  SELECT_SET:
    /^SELECT \* FROM repo_metadata WHERE \(repo_owner = \? AND repo_name = \?\)(?: OR \(repo_owner = \? AND repo_name = \?\))*$/,
  UPSERT: /^INSERT INTO repo_metadata/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, RepoMetadataRow>();
  readonly allQueries: Array<{ query: string; args: unknown[] }> = [];

  private rowKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_BY_PK.test(normalized)) {
      const [owner, name] = args as [string, string];
      return this.rows.get(this.rowKey(owner, name)) ?? null;
    }

    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    this.allQueries.push({ query: normalized, args });

    if (QUERY_PATTERNS.SELECT_BY_PK.test(normalized)) {
      const [owner, name] = args as [string, string];
      const row = this.rows.get(this.rowKey(owner, name));
      return row ? [row] : [];
    }

    if (QUERY_PATTERNS.SELECT_SET.test(normalized)) {
      const rows: RepoMetadataRow[] = [];
      for (let index = 0; index < args.length; index += 2) {
        const row = this.rows.get(this.rowKey(args[index] as string, args[index + 1] as string));
        if (row) rows.push(row);
      }
      return rows;
    }

    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.UPSERT.test(normalized)) {
      const [
        owner,
        name,
        description,
        aliases,
        channelAssociations,
        keywords,
        defaultEnvironmentId,
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];
      const key = this.rowKey(owner, name);
      const existing = this.rows.get(key);
      this.rows.set(key, {
        repo_owner: owner,
        repo_name: name,
        description,
        aliases,
        channel_associations: channelAssociations,
        keywords,
        default_environment_id: defaultEnvironmentId,
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("RepoMetadataStore", () => {
  let db: FakeD1Database;
  let store: RepoMetadataStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new RepoMetadataStore(db as unknown as D1Database);
  });

  describe("get", () => {
    it("returns metadata when found", async () => {
      await store.upsert("Owner", "Repo", {
        description: "A test repo",
        aliases: ["test"],
        channelAssociations: ["#general"],
        keywords: ["testing"],
        defaultEnvironmentId: "env_123",
      });

      const result = await store.get("Owner", "Repo");
      expect(result).toEqual({
        description: "A test repo",
        aliases: ["test"],
        channelAssociations: ["#general"],
        keywords: ["testing"],
        defaultEnvironmentId: "env_123",
      });
    });

    it("returns null when not found", async () => {
      const result = await store.get("owner", "nonexistent");
      expect(result).toBeNull();
    });

    it("handles partial metadata", async () => {
      await store.upsert("owner", "repo", { description: "Just a description" });

      const result = await store.get("owner", "repo");
      expect(result).toEqual({ description: "Just a description" });
      expect(result?.aliases).toBeUndefined();
      expect(result?.channelAssociations).toBeUndefined();
      expect(result?.keywords).toBeUndefined();
      expect(result?.defaultEnvironmentId).toBeUndefined();
    });

    it("normalizes owner and name to lowercase", async () => {
      await store.upsert("Owner", "Repo", { description: "test" });
      const result = await store.get("OWNER", "REPO");
      expect(result).not.toBeNull();
      expect(result?.description).toBe("test");
    });
  });

  describe("upsert", () => {
    it("inserts new metadata", async () => {
      await store.upsert("owner", "repo", { description: "new" });
      const result = await store.get("owner", "repo");
      expect(result?.description).toBe("new");
    });

    it("updates existing metadata", async () => {
      await store.upsert("owner", "repo", { description: "original" });
      await store.upsert("owner", "repo", { description: "updated", aliases: ["alias1"] });

      const result = await store.get("owner", "repo");
      expect(result?.description).toBe("updated");
      expect(result?.aliases).toEqual(["alias1"]);
    });

    it("clears defaultEnvironmentId when omitted from an update", async () => {
      await store.upsert("owner", "repo", { defaultEnvironmentId: "env_123" });
      await store.upsert("owner", "repo", { description: "no env" });

      const result = await store.get("owner", "repo");
      expect(result?.defaultEnvironmentId).toBeUndefined();
    });
  });

  describe("getBatch", () => {
    it("returns empty map for empty input", async () => {
      const result = await store.getBatch([]);
      expect(result.size).toBe(0);
      expect(db.allQueries).toHaveLength(0);
    });

    it("returns metadata for repos that have it", async () => {
      await store.upsert("owner", "repo1", { description: "First", defaultEnvironmentId: "env_1" });
      await store.upsert("owner", "repo2", { description: "Second", keywords: ["kw"] });

      const result = await store.getBatch([
        { owner: "owner", name: "repo1" },
        { owner: "owner", name: "repo2" },
        { owner: "owner", name: "repo3" },
      ]);

      expect(result.size).toBe(2);
      expect(result.get("owner/repo1")?.description).toBe("First");
      expect(result.get("owner/repo1")?.defaultEnvironmentId).toBe("env_1");
      expect(result.get("owner/repo2")?.description).toBe("Second");
      expect(result.get("owner/repo2")?.keywords).toEqual(["kw"]);
      expect(result.has("owner/repo3")).toBe(false);
    });

    it("chunks set queries at the D1 parameter limit", async () => {
      const tupleCapacity = Math.floor(MAX_D1_QUERY_PARAMETERS / 2);
      const repos = Array.from({ length: tupleCapacity + 1 }, (_, index) => ({
        owner: "owner",
        name: `repo-${index}`,
      }));

      await store.getBatch(repos.slice(0, tupleCapacity));
      expect(db.allQueries).toHaveLength(1);
      expect(db.allQueries[0].args).toHaveLength(MAX_D1_QUERY_PARAMETERS);

      db.allQueries.length = 0;
      await store.getBatch(repos);
      expect(db.allQueries).toHaveLength(2);
      expect(db.allQueries.map(({ args }) => args.length)).toEqual([MAX_D1_QUERY_PARAMETERS, 2]);
      expect(db.allQueries.every(({ args }) => args.length <= MAX_D1_QUERY_PARAMETERS)).toBe(true);
    });

    it("deduplicates normalized identities before querying", async () => {
      await store.upsert("Group/Subgroup", "Repo", { description: "Nested" });

      const result = await store.getBatch([
        { owner: "Group/Subgroup", name: "Repo" },
        { owner: "group/subgroup", name: "repo" },
        { owner: "GROUP/SUBGROUP", name: "REPO" },
      ]);

      expect(db.allQueries).toHaveLength(1);
      expect(db.allQueries[0].args).toEqual(["group/subgroup", "repo"]);
      expect(result).toEqual(new Map([["group/subgroup/repo", { description: "Nested" }]]));
    });

    it("returns found rows and omits missing rows across chunks", async () => {
      const tupleCapacity = Math.floor(MAX_D1_QUERY_PARAMETERS / 2);
      await store.upsert("Nested/Owner", "first", { description: "First" });
      await store.upsert("NESTED/OWNER", `repo-${tupleCapacity}`, { description: "Last" });

      const result = await store.getBatch([
        { owner: "Nested/Owner", name: "FIRST" },
        ...Array.from({ length: tupleCapacity }, (_, index) => ({
          owner: "nested/owner",
          name: `repo-${index + 1}`,
        })),
        { owner: "missing/owner", name: "missing" },
      ]);

      expect(db.allQueries).toHaveLength(2);
      expect(result).toEqual(
        new Map([
          ["nested/owner/first", { description: "First" }],
          [`nested/owner/repo-${tupleCapacity}`, { description: "Last" }],
        ])
      );
      expect(result.has("missing/owner/missing")).toBe(false);
    });
  });
});
