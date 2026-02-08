import { beforeEach, describe, expect, it } from "vitest";
import { RepoMetadataStore } from "./repo-metadata";

type RepoMetadataRow = {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  SELECT_BY_PK: /^SELECT \* FROM repo_metadata WHERE repo_owner = \? AND repo_name = \?$/,
  UPSERT: /^INSERT INTO repo_metadata/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, RepoMetadataRow>();

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

    if (QUERY_PATTERNS.SELECT_BY_PK.test(normalized)) {
      const [owner, name] = args as [string, string];
      const row = this.rows.get(this.rowKey(owner, name));
      return row ? [row] : [];
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
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string,
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
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }

  async batch<T>(statements: FakePreparedStatement[]): Promise<Array<{ results: T[] }>> {
    return statements.map((stmt) => {
      const results = stmt.allSync();
      return { results: results as T[] };
    });
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

  allSync() {
    return this.db.all(this.query, this.bound);
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
      });

      const result = await store.get("Owner", "Repo");
      expect(result).toEqual({
        description: "A test repo",
        aliases: ["test"],
        channelAssociations: ["#general"],
        keywords: ["testing"],
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
  });

  describe("getBatch", () => {
    it("returns empty map for empty input", async () => {
      const result = await store.getBatch([]);
      expect(result.size).toBe(0);
    });

    it("returns metadata for repos that have it", async () => {
      await store.upsert("owner", "repo1", { description: "First" });
      await store.upsert("owner", "repo2", { description: "Second", keywords: ["kw"] });

      const result = await store.getBatch([
        { owner: "owner", name: "repo1" },
        { owner: "owner", name: "repo2" },
        { owner: "owner", name: "repo3" },
      ]);

      expect(result.size).toBe(2);
      expect(result.get("owner/repo1")?.description).toBe("First");
      expect(result.get("owner/repo2")?.description).toBe("Second");
      expect(result.get("owner/repo2")?.keywords).toEqual(["kw"]);
      expect(result.has("owner/repo3")).toBe(false);
    });
  });
});
