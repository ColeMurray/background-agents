import { beforeEach, describe, expect, it } from "vitest";
import { ScmSettingsStore, ScmSettingsValidationError } from "./scm-settings";

type GlobalRow = { integration_id: string; settings: string };
type RepoRow = { integration_id: string; repo: string; settings: string };

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

const PATTERNS = {
  SELECT_GLOBAL: /^SELECT settings FROM integration_settings WHERE integration_id = \?$/,
  UPSERT_GLOBAL: /^INSERT INTO integration_settings/,
  DELETE_GLOBAL: /^DELETE FROM integration_settings WHERE integration_id = \?$/,
  SELECT_REPO:
    /^SELECT settings FROM integration_repo_settings WHERE integration_id = \? AND repo = \?$/,
  UPSERT_REPO: /^INSERT INTO integration_repo_settings/,
  DELETE_REPO: /^DELETE FROM integration_repo_settings WHERE integration_id = \? AND repo = \?$/,
  LIST_REPO: /^SELECT repo, settings FROM integration_repo_settings WHERE integration_id = \?$/,
};

class FakeD1Database {
  globalRows = new Map<string, GlobalRow>();
  repoRows = new Map<string, RepoRow>();

  prepare(query: string) {
    return new FakeStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const q = normalize(query);
    if (PATTERNS.SELECT_GLOBAL.test(q)) {
      const [id] = args as [string];
      const row = this.globalRows.get(id);
      return row ? { settings: row.settings } : null;
    }
    if (PATTERNS.SELECT_REPO.test(q)) {
      const [id, repo] = args as [string, string];
      const row = this.repoRows.get(`${id}:${repo}`);
      return row ? { settings: row.settings } : null;
    }
    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const q = normalize(query);
    if (PATTERNS.LIST_REPO.test(q)) {
      const [id] = args as [string];
      return [...this.repoRows.values()]
        .filter((r) => r.integration_id === id)
        .map((r) => ({ repo: r.repo, settings: r.settings }));
    }
    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const q = normalize(query);
    if (PATTERNS.UPSERT_GLOBAL.test(q)) {
      const [id, settings] = args as [string, string];
      this.globalRows.set(id, { integration_id: id, settings });
      return { meta: { changes: 1 } };
    }
    if (PATTERNS.UPSERT_REPO.test(q)) {
      const [id, repo, settings] = args as [string, string, string];
      this.repoRows.set(`${id}:${repo}`, { integration_id: id, repo, settings });
      return { meta: { changes: 1 } };
    }
    if (PATTERNS.DELETE_GLOBAL.test(q)) {
      const [id] = args as [string];
      this.globalRows.delete(id);
      return { meta: { changes: 1 } };
    }
    if (PATTERNS.DELETE_REPO.test(q)) {
      const [id, repo] = args as [string, string];
      this.repoRows.delete(`${id}:${repo}`);
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run() query: ${query}`);
  }
}

class FakeStatement {
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

describe("ScmSettingsStore", () => {
  let db: FakeD1Database;
  let store: ScmSettingsStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new ScmSettingsStore(db as unknown as D1Database);
  });

  it("returns null when global settings are unconfigured", async () => {
    expect(await store.getGlobal()).toBeNull();
  });

  it("round-trips global settings", async () => {
    await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
    expect(await store.getGlobal()).toEqual({ defaults: { alwaysUseDraftMode: true } });
  });

  it("round-trips per-repo settings (lowercasing the repo key)", async () => {
    await store.setRepoSettings("Acme/Web", { alwaysUseDraftMode: true });
    expect(await store.getRepoSettings("acme/web")).toEqual({ alwaysUseDraftMode: true });
  });

  it("rejects a non-boolean alwaysUseDraftMode", async () => {
    await expect(
      store.setGlobal({ defaults: { alwaysUseDraftMode: "yes" as unknown as boolean } })
    ).rejects.toThrow(ScmSettingsValidationError);
    await expect(
      store.setRepoSettings("acme/web", { alwaysUseDraftMode: 1 as unknown as boolean })
    ).rejects.toThrow(ScmSettingsValidationError);
  });

  it("stores SCM settings under the 'scm' key, not as an integration", async () => {
    await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
    expect([...db.globalRows.keys()]).toEqual(["scm"]);
  });

  it("lists repo overrides", async () => {
    await store.setRepoSettings("acme/web", { alwaysUseDraftMode: true });
    await store.setRepoSettings("acme/api", { alwaysUseDraftMode: false });
    const repos = await store.listRepoSettings();
    expect(repos).toHaveLength(2);
  });

  it("deletes global and repo settings", async () => {
    await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
    await store.setRepoSettings("acme/web", { alwaysUseDraftMode: true });
    await store.deleteGlobal();
    await store.deleteRepoSettings("acme/web");
    expect(await store.getGlobal()).toBeNull();
    expect(await store.getRepoSettings("acme/web")).toBeNull();
  });

  describe("getResolvedSettings", () => {
    it("falls back to the global default when no repo override exists", async () => {
      await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
      expect(await store.getResolvedSettings("acme/web")).toEqual({ alwaysUseDraftMode: true });
    });

    it("lets a repo override flip the global default", async () => {
      await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
      await store.setRepoSettings("acme/web", { alwaysUseDraftMode: false });
      expect(await store.getResolvedSettings("acme/web")).toEqual({ alwaysUseDraftMode: false });
    });

    it("returns an empty object when nothing is configured", async () => {
      expect(await store.getResolvedSettings("acme/web")).toEqual({});
    });
  });
});
