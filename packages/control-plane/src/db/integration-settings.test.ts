import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SLACK_ROUTING_KEYWORD_LENGTH, MAX_SLACK_ROUTING_RULES } from "@open-inspect/shared";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
  resolveSlackSettings,
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
    expect(isValidIntegrationId("slack")).toBe(true);
  });

  it("rejects unknown IDs", () => {
    expect(isValidIntegrationId("githb")).toBe(false);
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

    it("normalizes defaults.allowedTriggerUsers to lowercase", async () => {
      await store.setGlobal("github", {
        defaults: { allowedTriggerUsers: ["Alice", "BOB"] },
      });

      const result = await store.getGlobal("github");
      expect(result?.defaults?.allowedTriggerUsers).toEqual(["alice", "bob"]);
    });

    it("rejects non-array defaults.allowedTriggerUsers", async () => {
      await expect(
        store.setGlobal("github", {
          defaults: { allowedTriggerUsers: "alice" as unknown as string[] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects defaults.allowedTriggerUsers with non-string elements", async () => {
      await expect(
        store.setGlobal("github", {
          defaults: { allowedTriggerUsers: [123, null] as unknown as string[] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects enabledRepos with non-string elements", async () => {
      await expect(
        store.setGlobal("github", {
          enabledRepos: [42] as unknown as string[],
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
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

    it("normalizes per-repo allowedTriggerUsers to lowercase", async () => {
      await store.setRepoSettings("github", "acme/widgets", {
        allowedTriggerUsers: ["Alice", "BOB"],
      });

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result?.allowedTriggerUsers).toEqual(["alice", "bob"]);
    });

    it("rejects non-array per-repo allowedTriggerUsers", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          allowedTriggerUsers: "alice" as unknown as string[],
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("accepts valid codeReviewInstructions string", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          codeReviewInstructions: "Focus on security.",
        })
      ).resolves.not.toThrow();

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result?.codeReviewInstructions).toBe("Focus on security.");
    });

    it("rejects non-string codeReviewInstructions", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          codeReviewInstructions: 123 as unknown as string,
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("accepts valid commentActionInstructions string", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          commentActionInstructions: "Run tests first.",
        })
      ).resolves.not.toThrow();

      const result = await store.getRepoSettings("github", "acme/widgets");
      expect(result?.commentActionInstructions).toBe("Run tests first.");
    });

    it("rejects non-string commentActionInstructions", async () => {
      await expect(
        store.setRepoSettings("github", "acme/widgets", {
          commentActionInstructions: true as unknown as string,
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
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

    it("returns undefined allowedTriggerUsers in settings when not configured", async () => {
      await store.setGlobal("github", { defaults: { autoReviewOnOpen: true } });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.allowedTriggerUsers).toBeUndefined();
    });

    it("preserves empty allowedTriggerUsers array in settings (deny all)", async () => {
      await store.setGlobal("github", { defaults: { allowedTriggerUsers: [] } });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.allowedTriggerUsers).toEqual([]);
    });

    it("returns allowedTriggerUsers list in settings when configured as default", async () => {
      await store.setGlobal("github", {
        defaults: { allowedTriggerUsers: ["alice", "bob"] },
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.allowedTriggerUsers).toEqual(["alice", "bob"]);
    });

    it("per-repo allowedTriggerUsers overrides global default", async () => {
      await store.setGlobal("github", {
        defaults: { allowedTriggerUsers: ["alice", "bob"] },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        allowedTriggerUsers: ["carol"],
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.allowedTriggerUsers).toEqual(["carol"]);
    });

    it("global allowedTriggerUsers preserved when repo doesn't override", async () => {
      await store.setGlobal("github", {
        defaults: { allowedTriggerUsers: ["alice", "bob"] },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        model: "anthropic/claude-opus-4-6",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.allowedTriggerUsers).toEqual(["alice", "bob"]);
      expect(config.settings.model).toBe("anthropic/claude-opus-4-6");
    });

    it("global codeReviewInstructions surfaces in resolved config", async () => {
      await store.setGlobal("github", {
        defaults: { codeReviewInstructions: "Focus on security." },
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.codeReviewInstructions).toBe("Focus on security.");
    });

    it("repo override codeReviewInstructions replaces global default", async () => {
      await store.setGlobal("github", {
        defaults: { codeReviewInstructions: "Global instructions." },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        codeReviewInstructions: "Repo-specific instructions.",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.codeReviewInstructions).toBe("Repo-specific instructions.");
    });

    it("global commentActionInstructions surfaces in resolved config", async () => {
      await store.setGlobal("github", {
        defaults: { commentActionInstructions: "Run tests first." },
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.commentActionInstructions).toBe("Run tests first.");
    });

    it("repo override commentActionInstructions replaces global default", async () => {
      await store.setGlobal("github", {
        defaults: { commentActionInstructions: "Global comment instructions." },
      });
      await store.setRepoSettings("github", "acme/widgets", {
        commentActionInstructions: "Repo comment instructions.",
      });

      const config = await store.getResolvedConfig("github", "acme/widgets");
      expect(config.settings.commentActionInstructions).toBe("Repo comment instructions.");
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

  describe("sandbox integration", () => {
    it("isValidIntegrationId('sandbox') returns true", () => {
      expect(isValidIntegrationId("sandbox")).toBe(true);
    });

    it("round-trips global sandbox settings", async () => {
      await store.setGlobal("sandbox", {
        defaults: {
          tunnelPorts: [3000, 3001],
          maxConcurrentChildSessions: 3,
          maxTotalChildSessions: 8,
        },
      });

      const result = await store.getGlobal("sandbox");
      expect(result).toEqual({
        defaults: {
          tunnelPorts: [3000, 3001],
          maxConcurrentChildSessions: 3,
          maxTotalChildSessions: 8,
        },
      });
    });

    it("round-trips per-repo sandbox settings", async () => {
      await store.setRepoSettings("sandbox", "acme/app", { tunnelPorts: [5173] });

      const result = await store.getRepoSettings("sandbox", "acme/app");
      expect(result).toEqual({ tunnelPorts: [5173] });
    });

    it("getResolvedConfig merges global defaults with repo overrides", async () => {
      await store.setGlobal("sandbox", { defaults: { tunnelPorts: [3000, 3001] } });
      await store.setRepoSettings("sandbox", "acme/app", { tunnelPorts: [5173] });

      const config = await store.getResolvedConfig("sandbox", "acme/app");
      // Repo tunnelPorts wins over global defaults
      expect(config.settings.tunnelPorts).toEqual([5173]);
    });

    it("getResolvedConfig falls back to global defaults when no repo override", async () => {
      await store.setGlobal("sandbox", { defaults: { tunnelPorts: [3000, 3001] } });

      const config = await store.getResolvedConfig("sandbox", "acme/other");
      expect(config.settings.tunnelPorts).toEqual([3000, 3001]);
    });

    it("getResolvedConfig merges child session limit overrides", async () => {
      await store.setGlobal("sandbox", {
        defaults: { maxConcurrentChildSessions: 5, maxTotalChildSessions: 15 },
      });
      await store.setRepoSettings("sandbox", "acme/app", { maxConcurrentChildSessions: 2 });

      const config = await store.getResolvedConfig("sandbox", "acme/app");
      expect(config.settings).toEqual({
        maxConcurrentChildSessions: 2,
        maxTotalChildSessions: 15,
      });
    });

    it("rejects non-array tunnelPorts", async () => {
      await expect(
        store.setGlobal("sandbox", {
          defaults: { tunnelPorts: "not-an-array" as unknown as number[] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects port out of range", async () => {
      await expect(
        store.setGlobal("sandbox", { defaults: { tunnelPorts: [99999] } })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects too many ports (>10)", async () => {
      await expect(
        store.setGlobal("sandbox", {
          defaults: { tunnelPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects invalid child session limits", async () => {
      await expect(
        store.setGlobal("sandbox", { defaults: { maxConcurrentChildSessions: 1.5 } })
      ).rejects.toThrow(IntegrationSettingsValidationError);

      await expect(
        store.setGlobal("sandbox", { defaults: { maxTotalChildSessions: -1 } })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects concurrent child session limits greater than total limits", async () => {
      await expect(
        store.setGlobal("sandbox", {
          defaults: { maxConcurrentChildSessions: 6, maxTotalChildSessions: 5 },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("normalizes cross-field violations that only appear after merge", async () => {
      // Each blob is individually valid — neither write throws — because the
      // invariant (concurrent <= total) spans two fields set in different scopes.
      // The violation only materializes in the merged result, so getResolvedConfig's
      // normalize pass is the only thing that catches it. This pins that pass.
      await store.setGlobal("sandbox", { defaults: { maxConcurrentChildSessions: 3 } });
      await store.setRepoSettings("sandbox", "acme/app", { maxTotalChildSessions: 2 });

      const config = await store.getResolvedConfig("sandbox", "acme/app");
      // Merge would be { maxConcurrentChildSessions: 3, maxTotalChildSessions: 2 };
      // the resolve-time normalize drops the inverted concurrent limit.
      expect(config.settings).toEqual({ maxTotalChildSessions: 2 });
    });

    it("round-trips fractional cpuCores and small memoryMib", async () => {
      await store.setRepoSettings("sandbox", "acme/app", { cpuCores: 0.5, memoryMib: 64 });

      const result = await store.getRepoSettings("sandbox", "acme/app");
      expect(result).toEqual({ cpuCores: 0.5, memoryMib: 64 });
    });

    it("preserves null repo resource overrides over inherited global defaults", async () => {
      await store.setGlobal("sandbox", { defaults: { cpuCores: 2, memoryMib: 4096 } });
      await store.setRepoSettings("sandbox", "acme/app", { cpuCores: null, memoryMib: null });

      const repoSettings = await store.getRepoSettings("sandbox", "acme/app");
      expect(repoSettings).toEqual({ cpuCores: null, memoryMib: null });

      const resolved = await store.getResolvedConfig("sandbox", "acme/app");
      expect(resolved.settings).toEqual({ cpuCores: null, memoryMib: null });
    });

    it("rejects non-positive cpuCores", async () => {
      await expect(store.setGlobal("sandbox", { defaults: { cpuCores: 0 } })).rejects.toThrow(
        IntegrationSettingsValidationError
      );
    });

    it("rejects non-integer memoryMib", async () => {
      await expect(store.setGlobal("sandbox", { defaults: { memoryMib: 256.5 } })).rejects.toThrow(
        IntegrationSettingsValidationError
      );
    });

    it("rejects non-positive memoryMib", async () => {
      await expect(store.setGlobal("sandbox", { defaults: { memoryMib: 0 } })).rejects.toThrow(
        IntegrationSettingsValidationError
      );
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

  describe("slack settings", () => {
    it("round-trips global slack settings", async () => {
      await store.setGlobal("slack", {
        defaults: { agentNotificationsEnabled: true, mentionsPolicy: "escape" },
      });

      const result = await store.getGlobal("slack");
      expect(result).toEqual({
        defaults: { agentNotificationsEnabled: true, mentionsPolicy: "escape" },
      });
    });

    it("round-trips a global slack default model", async () => {
      await store.setGlobal("slack", {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
      });

      const result = await store.getGlobal("slack");
      expect(result?.defaults?.model).toBe("anthropic/claude-sonnet-4-6");
    });

    it("rejects invalid slack default models", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { model: "not-a-real-model" },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("accepts every valid mentionsPolicy value at global level", async () => {
      for (const policy of ["allow", "escape", "strip"] as const) {
        await store.setGlobal("slack", { defaults: { mentionsPolicy: policy } });
        const result = await store.getGlobal("slack");
        expect(result?.defaults?.mentionsPolicy).toBe(policy);
      }
    });

    it("rejects invalid mentionsPolicy at global level", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { mentionsPolicy: "yell" as unknown as "allow" },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects non-boolean agentNotificationsEnabled at global level", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { agentNotificationsEnabled: "yes" as unknown as boolean },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects unknown field at global level", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { foo: "bar" } as unknown as { agentNotificationsEnabled?: boolean },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("round-trips per-repo slack settings", async () => {
      await store.setRepoSettings("slack", "acme/widgets", {
        agentNotificationsEnabled: false,
      });

      const result = await store.getRepoSettings("slack", "acme/widgets");
      expect(result).toEqual({ agentNotificationsEnabled: false });
    });

    it("rejects mentionsPolicy at per-repo level (global-only field)", async () => {
      await expect(
        store.setRepoSettings("slack", "acme/widgets", {
          mentionsPolicy: "escape",
        } as unknown as { agentNotificationsEnabled?: boolean })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects model at per-repo level (global-only field)", async () => {
      await expect(
        store.setRepoSettings("slack", "acme/widgets", {
          model: "anthropic/claude-sonnet-4-6",
        } as unknown as { agentNotificationsEnabled?: boolean })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects unknown field at per-repo level", async () => {
      await expect(
        store.setRepoSettings("slack", "acme/widgets", {
          foo: "bar",
        } as unknown as { agentNotificationsEnabled?: boolean })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects non-boolean agentNotificationsEnabled at per-repo level", async () => {
      await expect(
        store.setRepoSettings("slack", "acme/widgets", {
          agentNotificationsEnabled: 1 as unknown as boolean,
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("getResolvedConfig: repo agentNotificationsEnabled overrides global", async () => {
      await store.setGlobal("slack", {
        defaults: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
      });
      await store.setRepoSettings("slack", "acme/widgets", {
        agentNotificationsEnabled: true,
      });

      const config = await store.getResolvedConfig("slack", "acme/widgets");
      expect(config.settings.agentNotificationsEnabled).toBe(true);
      expect(config.settings.mentionsPolicy).toBe("allow");
    });

    it("getResolvedConfig: mentionsPolicy comes from global only", async () => {
      await store.setGlobal("slack", {
        defaults: { mentionsPolicy: "strip" },
      });
      await store.setRepoSettings("slack", "acme/widgets", {
        agentNotificationsEnabled: true,
      });

      const config = await store.getResolvedConfig("slack", "acme/widgets");
      expect(config.settings.mentionsPolicy).toBe("strip");
      expect(config.settings.agentNotificationsEnabled).toBe(true);
    });

    it("getResolvedConfig: returns empty settings when nothing configured", async () => {
      const config = await store.getResolvedConfig("slack", "acme/widgets");
      expect(config).toEqual({ enabledRepos: null, settings: {} });
    });

    it("getResolvedConfig: global agentNotificationsEnabled used when no repo override", async () => {
      await store.setGlobal("slack", {
        defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
      });

      const config = await store.getResolvedConfig("slack", "acme/widgets");
      expect(config.settings.agentNotificationsEnabled).toBe(true);
      expect(config.settings.mentionsPolicy).toBe("allow");
    });

    it("round-trips and normalizes routingRules at global level", async () => {
      await store.setGlobal("slack", {
        defaults: {
          routingRules: [
            { keyword: "  FrontEnd ", target: "Acme/Web-App" },
            { keyword: "api", target: "acme/api" },
          ],
        },
      });

      const result = await store.getGlobal("slack");
      expect(result?.defaults?.routingRules).toEqual([
        { keyword: "frontend", target: "acme/web-app" },
        { keyword: "api", target: "acme/api" },
      ]);
    });

    it("rejects routingRules at per-repo level (global-only field)", async () => {
      await expect(
        store.setRepoSettings("slack", "acme/widgets", {
          routingRules: [{ keyword: "frontend", target: "acme/web" }],
        } as unknown as { agentNotificationsEnabled?: boolean })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects non-array routingRules", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { routingRules: "frontend" as unknown as [] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects a routing rule with an empty keyword", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { routingRules: [{ keyword: "   ", target: "acme/web" }] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects a routing rule whose target is not in owner/name form", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: { routingRules: [{ keyword: "frontend", target: "not-a-repo" }] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("round-trips an environment-targeted routing rule", async () => {
      await store.setGlobal("slack", {
        defaults: {
          routingRules: [
            { keyword: "FullStack", target: "env_abc123", targetType: "environment" },
            { keyword: "api", target: "acme/api" },
          ],
        },
      });

      const result = await store.getGlobal("slack");
      expect(result?.defaults?.routingRules).toEqual([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
        { keyword: "api", target: "acme/api" },
      ]);
    });

    it("rejects an environment-targeted rule whose target is not an env_ id", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: {
            routingRules: [{ keyword: "fullstack", target: "acme/web", targetType: "environment" }],
          },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects a repository target whose owner contains a colon", async () => {
      // "env:foo/bar" must not be storable as a repository — it would collide
      // with the bots' env:<id> option-value encoding.
      await expect(
        store.setGlobal("slack", {
          defaults: { routingRules: [{ keyword: "frontend", target: "env:foo/bar" }] },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects an unknown routing rule targetType", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: {
            routingRules: [
              {
                keyword: "fullstack",
                target: "acme/web",
                targetType: "team" as unknown as "repository",
              },
            ],
          },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects a routing rule keyword longer than the maximum", async () => {
      await expect(
        store.setGlobal("slack", {
          defaults: {
            routingRules: [
              { keyword: "x".repeat(MAX_SLACK_ROUTING_KEYWORD_LENGTH + 1), target: "acme/web" },
            ],
          },
        })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });

    it("rejects more than the maximum number of routing rules", async () => {
      const tooMany = Array.from({ length: MAX_SLACK_ROUTING_RULES + 1 }, (_, i) => ({
        keyword: `kw${i}`,
        target: `acme/repo${i}`,
      }));
      await expect(
        store.setGlobal("slack", { defaults: { routingRules: tooMany } })
      ).rejects.toThrow(IntegrationSettingsValidationError);
    });
  });

  describe("resolveSlackSettings", () => {
    it("treats undefined as disabled with default mention policy", () => {
      expect(resolveSlackSettings(undefined)).toEqual({
        agentNotificationsEnabled: false,
        mentionsPolicy: "allow",
      });
    });

    it("treats empty object as disabled with default mention policy", () => {
      expect(resolveSlackSettings({})).toEqual({
        agentNotificationsEnabled: false,
        mentionsPolicy: "allow",
      });
    });

    it("returns enabled true only when the flag is exactly true", () => {
      expect(
        resolveSlackSettings({ agentNotificationsEnabled: true }).agentNotificationsEnabled
      ).toBe(true);
      expect(
        resolveSlackSettings({ agentNotificationsEnabled: false }).agentNotificationsEnabled
      ).toBe(false);
    });

    it("preserves a configured mention policy", () => {
      expect(resolveSlackSettings({ mentionsPolicy: "strip" }).mentionsPolicy).toBe("strip");
      expect(resolveSlackSettings({ mentionsPolicy: "escape" }).mentionsPolicy).toBe("escape");
    });
  });
});
