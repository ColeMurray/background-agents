import { beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
} from "./integration-settings";

type GlobalRow = {
  integration_id: string;
  settings: string;
  created_at: number;
  updated_at: number;
};

type RepoRow = {
  integration_id: string;
  repo: string;
  settings: string;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  SELECT_GLOBAL: /^SELECT settings FROM integration_settings WHERE integration_id = \?$/,
  UPSERT_GLOBAL: /^INSERT INTO integration_settings/,
  DELETE_GLOBAL: /^DELETE FROM integration_settings WHERE integration_id = \?$/,
  SELECT_REPO:
    /^SELECT settings FROM integration_repo_settings WHERE integration_id = \? AND repo = \?$/,
  UPSERT_REPO: /^INSERT INTO integration_repo_settings/,
  DELETE_REPO: /^DELETE FROM integration_repo_settings WHERE integration_id = \? AND repo = \?$/,
  LIST_REPO: /^SELECT repo, settings FROM integration_repo_settings WHERE integration_id = \?$/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private globalRows = new Map<string, GlobalRow>();
  private repoRows = new Map<string, RepoRow>();

  private repoKey(integrationId: string, repo: string): string {
    return `${integrationId}:${repo}`;
  }

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_GLOBAL.test(normalized)) {
      const [integrationId] = args as [string];
      const row = this.globalRows.get(integrationId);
      return row ? { settings: row.settings } : null;
    }

    if (QUERY_PATTERNS.SELECT_REPO.test(normalized)) {
      const [integrationId, repo] = args as [string, string];
      const row = this.repoRows.get(this.repoKey(integrationId, repo));
      return row ? { settings: row.settings } : null;
    }

    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.LIST_REPO.test(normalized)) {
      const [integrationId] = args as [string];
      const results: Array<{ repo: string; settings: string }> = [];
      for (const row of this.repoRows.values()) {
        if (row.integration_id === integrationId) {
          results.push({ repo: row.repo, settings: row.settings });
        }
      }
      return results;
    }

    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.UPSERT_GLOBAL.test(normalized)) {
      const [integrationId, settings, createdAt, updatedAt] = args as [
        string,
        string,
        number,
        number,
      ];
      const existing = this.globalRows.get(integrationId);
      this.globalRows.set(integrationId, {
        integration_id: integrationId,
        settings,
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.UPSERT_REPO.test(normalized)) {
      const [integrationId, repo, settings, createdAt, updatedAt] = args as [
        string,
        string,
        string,
        number,
        number,
      ];
      const key = this.repoKey(integrationId, repo);
      const existing = this.repoRows.get(key);
      this.repoRows.set(key, {
        integration_id: integrationId,
        repo,
        settings,
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE_GLOBAL.test(normalized)) {
      const [integrationId] = args as [string];
      this.globalRows.delete(integrationId);
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE_REPO.test(normalized)) {
      const [integrationId, repo] = args as [string, string];
      this.repoRows.delete(this.repoKey(integrationId, repo));
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

describe("isValidIntegrationId", () => {
  it("accepts known integration IDs", () => {
    expect(isValidIntegrationId("github")).toBe(true);
    expect(isValidIntegrationId("linear")).toBe(true);
  });

  it("rejects unknown IDs", () => {
    expect(isValidIntegrationId("githb")).toBe(false);
    expect(isValidIntegrationId("slack")).toBe(false);
    expect(isValidIntegrationId("")).toBe(false);
  });
});

describe("IntegrationSettingsStore", () => {
  let db: FakeD1Database;
  let store: IntegrationSettingsStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new IntegrationSettingsStore(db as unknown as D1Database);
  });

  describe("global CRUD", () => {
    it("returns null when unconfigured", async () => {
      const result = await store.getGlobal("github");
      expect(result).toBeNull();
    });

    it("round-trips set + get", async () => {
      await store.setGlobal("github", {
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });

      const result = await store.getGlobal("github");
      expect(result).toEqual({
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });
    });

    it("update overwrites previous settings", async () => {
      await store.setGlobal("github", { defaults: { autoReviewOnOpen: true } });
      await store.setGlobal("github", {
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });

      const result = await store.getGlobal("github");
      expect(result).toEqual({
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });
    });

    it("delete removes the global settings row", async () => {
      await store.setGlobal("github", { defaults: { autoReviewOnOpen: false } });
      await store.deleteGlobal("github");

      const result = await store.getGlobal("github");
      expect(result).toBeNull();
    });

    it("normalizes enabledRepos to lowercase", async () => {
      await store.setGlobal("github", {
        enabledRepos: ["Acme/Widgets", "FOO/BAR"],
      });

      const result = await store.getGlobal("github");
      expect(result?.enabledRepos).toEqual(["acme/widgets", "foo/bar"]);
    });

    it("validates defaults.model on setGlobal", async () => {
      await expect(
        store.setGlobal("github", {
          defaults: { model: "invalid-model" },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("validates defaults.reasoningEffort on setGlobal", async () => {
      await expect(
        store.setGlobal("github", {
          defaults: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low" },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("accepts valid defaults on setGlobal", async () => {
      await expect(
        store.setGlobal("github", {
          defaults: { model: "anthropic/claude-opus-4-6", reasoningEffort: "high" },
        })
      ).resolves.not.toThrow();
    });
  });

  describe("per-repo CRUD", () => {
    it("returns null for unconfigured repo", async () => {
      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result).toBeNull();
    });

    it("round-trips set + get", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
        reasoningEffort: "high",
      });

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result).toEqual({
        model: "anthropic/claude-opus-4-6",
        reasoningEffort: "high",
      });
    });

    it("delete removes the override", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
      });
      await store.deleteRepoSettings("github", "acme/widgets");

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result).toBeNull();
    });

    it("list returns all overrides for integration", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
      });
      await store.setRepoSettings("github", "acme/gadgets", {
        model: "anthropic/claude-haiku-4-5",
      });

      const list = await store.listRepoSettings("github");
      expect(list).toHaveLength(2);
      const repos = list.map((r) => r.repo).sort();
      expect(repos).toEqual(["acme/gadgets", "acme/widgets"]);
    });

    it("normalizes repo name to lowercase on write and lookup", async () => {
      await store.setRepoSettings("github", "Acme/Widgets", {
        model: "anthropic/claude-opus-4-6",
      });

      // Lookup with different casing
      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result).not.toBeNull();
      expect(result?.model).toBe("anthropic/claude-opus-4-6");
    });

    it("supports autoReviewOnOpen as per-repo override", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        autoReviewOnOpen: false,
      });

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result?.autoReviewOnOpen).toBe(false);
    });
  });

  describe("merge logic (getResolvedConfig)", () => {
    it("returns empty settings when nothing is configured", async () => {
      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config).toEqual({
        enabledRepos: null,
        settings: {},
      });
    });

    it("returns global defaults when no repo override", async () => {
      await store.setGlobal("github", {
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.autoReviewOnOpen).toBe(false);
      expect(config.enabledRepos).toEqual(["acme/widgets"]);
      expect(config.settings.model).toBeUndefined();
    });

    it("merges repo override on top of global defaults", async () => {
      await store.setGlobal("github", {
        enabledRepos: ["acme/widgets"],
        defaults: { autoReviewOnOpen: false },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
        reasoningEffort: "high",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.autoReviewOnOpen).toBe(false);
      expect(config.enabledRepos).toEqual(["acme/widgets"]);
      expect(config.settings.model).toBe("anthropic/claude-opus-4-6");
      expect(config.settings.reasoningEffort).toBe("high");
    });

    it("per-repo autoReviewOnOpen overrides global default", async () => {
      await store.setGlobal("github", {
        defaults: { autoReviewOnOpen: true },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        autoReviewOnOpen: false,
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.autoReviewOnOpen).toBe(false);
    });

    it("global default model is used when no repo override", async () => {
      await store.setGlobal("github", {
        defaults: { model: "anthropic/claude-opus-4-6" },
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.model).toBe("anthropic/claude-opus-4-6");
    });

    it("repo model overrides global default model", async () => {
      await store.setGlobal("github", {
        defaults: { model: "anthropic/claude-opus-4-6" },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-haiku-4-5",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("handles missing global gracefully", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.enabledRepos).toBeNull();
      expect(config.settings.model).toBe("anthropic/claude-opus-4-6");
    });

    it("normalizes undefined enabledRepos to null", async () => {
      await store.setGlobal("github", { defaults: { autoReviewOnOpen: true } });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.enabledRepos).toBeNull();
    });

    it("preserves empty enabledRepos array (disabled state)", async () => {
      await store.setGlobal("github", { enabledRepos: [] });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.enabledRepos).toEqual([]);
    });
  });

  describe("cross-field validation", () => {
    it("rejects invalid reasoning effort for model on write", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          model: "anthropic/claude-haiku-4-5",
          reasoningEffort: "low",
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("accepts valid reasoning effort for model on write", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          model: "anthropic/claude-opus-4-6",
          reasoningEffort: "low",
        })
      ).resolves.not.toThrow();
    });

    it("preserves merged settings without domain-specific filtering", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
        reasoningEffort: "low",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.model).toBe("anthropic/claude-opus-4-6");
      expect(config.settings.reasoningEffort).toBe("low");
    });
  });

  describe("validation errors", () => {
    it("rejects invalid model ID", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          model: "invalid-model",
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          model: "invalid-model",
        })
      ).rejects.toThrow("Invalid model ID");
    });

    it("allows setting effort without model (inherited)", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          reasoningEffort: "high",
        })
      ).resolves.not.toThrow();
    });
  });

  describe("linear settings", () => {
    it("round-trips global linear settings", async () => {
      await store.setGlobal("linear", {
        enabledRepos: ["acme/platform"],
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: false,
          emitToolProgressActivities: false,
        },
      });

      const result = await store.getGlobal("linear");
      expect(result).toEqual({
        enabledRepos: ["acme/platform"],
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: false,
          emitToolProgressActivities: false,
        },
      });
    });

    it("round-trips linear repo settings", async () => {
      await store.setRepoSettings("linear", "acme/platform", {
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "high",
        allowLabelModelOverride: false,
      });

      const result = await store.getRepoSettings("linear", "acme/platform");
      expect(result).toEqual({
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "high",
        allowLabelModelOverride: false,
      });
    });

    it("rejects invalid linear boolean setting", async () => {
      await expect(
        store.setGlobal("linear", {
          defaults: { allowUserPreferenceOverride: "invalid" as unknown as boolean },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("merges linear global and repo settings", async () => {
      await store.setGlobal("linear", {
        enabledRepos: ["acme/platform"],
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          allowUserPreferenceOverride: true,
        },
      });
      await store.setRepoSettings("linear", "acme/platform", {
        allowUserPreferenceOverride: false,
        emitToolProgressActivities: false,
      });

      const config = await store.getResolvedConfig("linear", "acme/platform");
      expect(config.enabledRepos).toEqual(["acme/platform"]);
      expect(config.settings).toEqual({
        model: "anthropic/claude-sonnet-4-6",
        allowUserPreferenceOverride: false,
        emitToolProgressActivities: false,
      });
    });
  });
});
