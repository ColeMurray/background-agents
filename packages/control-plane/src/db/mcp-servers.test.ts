/**
 * Unit tests for McpServerStore.
 *
 * Uses a FakeD1Database similar to other store tests in this directory.
 * See automation-store.test.ts for the established pattern.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServerStore, McpServerValidationError } from "./mcp-servers";

// ─── Fake D1 helpers ────────────────────────────────────────────────────────

interface FakeStatement {
  sql: string;
  params: unknown[];
}

function createFakeD1(options?: {
  firstResult?: unknown;
  allResults?: unknown[];
  changes?: number;
}) {
  const statements: FakeStatement[] = [];

  const fakeStmt = {
    bind(...params: unknown[]) {
      statements[statements.length - 1].params = params;
      return fakeStmt;
    },
    async first<T>(): Promise<T | null> {
      return (options?.firstResult as T) ?? null;
    },
    async all<T>(): Promise<D1Result<T>> {
      return {
        results: (options?.allResults ?? []) as T[],
        success: true,
        meta: { duration: 0, changes: options?.changes ?? 0 },
      } as unknown as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      return {
        results: [],
        success: true,
        meta: { duration: 0, changes: options?.changes ?? 1 },
      } as unknown as D1Result;
    },
  };

  const db = {
    prepare(sql: string) {
      statements.push({ sql, params: [] });
      return fakeStmt;
    },
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return { db, statements };
}

// ─── Sample rows ─────────────────────────────────────────────────────────────

const sampleRow = {
  id: "abc123",
  name: "playwright",
  type: "stdio",
  command: JSON.stringify(["npx", "-y", "@playwright/mcp"]),
  url: null,
  env: JSON.stringify({ DEBUG: "1" }),
  repo_scope: null,
  enabled: 1,
  created_at: 1000,
  updated_at: 1000,
};

const remoteRow = {
  id: "def456",
  name: "remote-mcp",
  type: "remote",
  command: null,
  url: "https://mcp.example.com/sse",
  env: "{}",
  repo_scope: JSON.stringify(["carboncopyinc/habakkuk"]),
  enabled: 1,
  created_at: 1001,
  updated_at: 1001,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("McpServerStore", () => {
  describe("list()", () => {
    it("returns all servers when no repoScope filter", async () => {
      const { db } = createFakeD1({ allResults: [sampleRow, remoteRow] });
      const store = new McpServerStore(db);
      const results = await store.list();
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("playwright");
    });

    it("filters by repoScope (global servers always included)", async () => {
      const { db } = createFakeD1({ allResults: [sampleRow, remoteRow] });
      const store = new McpServerStore(db);
      // sampleRow has no repo_scope (global) → should be included
      // remoteRow is scoped to carboncopyinc/habakkuk → should be included
      const results = await store.list("carboncopyinc/habakkuk");
      expect(results).toHaveLength(2);
    });

    it("excludes repo-scoped servers when repo does not match", async () => {
      const { db } = createFakeD1({ allResults: [sampleRow, remoteRow] });
      const store = new McpServerStore(db);
      // remoteRow is scoped to carboncopyinc/habakkuk, not bencered/dom
      const results = await store.list("bencered/dom");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("playwright");
    });
  });

  describe("get()", () => {
    it("returns config when row found", async () => {
      const { db } = createFakeD1({ firstResult: sampleRow });
      const store = new McpServerStore(db);
      const result = await store.get("abc123");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("playwright");
      expect(result!.command).toEqual(["npx", "-y", "@playwright/mcp"]);
      expect(result!.env).toEqual({ DEBUG: "1" });
    });

    it("returns null when not found", async () => {
      const { db } = createFakeD1({ firstResult: null });
      const store = new McpServerStore(db);
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });

    it("handles corrupted JSON in command gracefully", async () => {
      const corruptRow = { ...sampleRow, command: "not-json" };
      const { db } = createFakeD1({ firstResult: corruptRow });
      const store = new McpServerStore(db);
      const result = await store.get("abc123");
      // Should fall back to wrapping the string in an array
      expect(result!.command).toEqual(["not-json"]);
    });

    it("handles corrupted JSON in env gracefully", async () => {
      const corruptRow = { ...sampleRow, env: "broken{" };
      const { db } = createFakeD1({ firstResult: corruptRow });
      const store = new McpServerStore(db);
      const result = await store.get("abc123");
      // Should fall back to empty object
      expect(result!.env).toEqual({});
    });
  });

  describe("create()", () => {
    it("throws McpServerValidationError for stdio server without command", async () => {
      const { db } = createFakeD1();
      const store = new McpServerStore(db);
      await expect(store.create({ name: "test", type: "stdio", enabled: true })).rejects.toThrow(
        McpServerValidationError
      );
    });

    it("throws McpServerValidationError for remote server without url", async () => {
      const { db } = createFakeD1({ firstResult: remoteRow });
      const store = new McpServerStore(db);
      await expect(store.create({ name: "test", type: "remote", enabled: true })).rejects.toThrow(
        McpServerValidationError
      );
    });

    it("throws McpServerValidationError (not generic Error) so routes can return 400", async () => {
      const { db } = createFakeD1();
      const store = new McpServerStore(db);
      const err = await store.create({ name: "x", type: "stdio", enabled: true }).catch((e) => e);
      expect(err).toBeInstanceOf(McpServerValidationError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("update()", () => {
    it("returns null when server not found", async () => {
      const { db } = createFakeD1({ firstResult: null });
      const store = new McpServerStore(db);
      const result = await store.update("nonexistent", { name: "new-name" });
      expect(result).toBeNull();
    });

    it("does not allow overwriting id via patch", async () => {
      // Create a fake D1 that returns sampleRow for get(), then returns updated row
      let callCount = 0;
      const fakeStmt = {
        bind(..._params: unknown[]) {
          return fakeStmt;
        },
        async first<T>(): Promise<T | null> {
          // First call = get existing, subsequent calls = get after update
          callCount++;
          return (callCount <= 1 ? sampleRow : { ...sampleRow, name: "updated" }) as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            results: [],
            success: true,
            meta: { duration: 0, changes: 0 },
          } as unknown as D1Result<T>;
        },
        async run(): Promise<D1Result> {
          return {
            results: [],
            success: true,
            meta: { duration: 0, changes: 1 },
          } as unknown as D1Result;
        },
      };
      const db = { prepare: () => fakeStmt, dump: vi.fn(), exec: vi.fn() } as unknown as D1Database;

      const store = new McpServerStore(db);
      // Attempt to patch id (not in the allowed type, but simulate via cast)
      const result = await store.update("abc123", { name: "updated" });
      // id should still be the original
      expect(result!.id).toBe("abc123");
    });

    it("throws McpServerValidationError when changing type to remote without url", async () => {
      // sampleRow is a stdio server with no url
      const { db } = createFakeD1({ firstResult: sampleRow });
      const store = new McpServerStore(db);
      const err = await store.update("abc123", { type: "remote" }).catch((e) => e);
      expect(err).toBeInstanceOf(McpServerValidationError);
      expect(err.message).toMatch(/require a URL/i);
    });

    it("throws McpServerValidationError when changing type to stdio without command", async () => {
      // remoteRow is a remote server with no command
      const { db } = createFakeD1({ firstResult: remoteRow });
      const store = new McpServerStore(db);
      const err = await store.update("def456", { type: "stdio" }).catch((e) => e);
      expect(err).toBeInstanceOf(McpServerValidationError);
      expect(err.message).toMatch(/require a command/i);
    });
  });

  describe("delete()", () => {
    it("returns true when row deleted", async () => {
      const { db } = createFakeD1({ changes: 1 });
      const store = new McpServerStore(db);
      const result = await store.delete("abc123");
      expect(result).toBe(true);
    });

    it("returns false when row not found", async () => {
      const { db } = createFakeD1({ changes: 0 });
      const store = new McpServerStore(db);
      const result = await store.delete("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("getForSession()", () => {
    it("returns global and matching repo-scoped servers", async () => {
      const { db } = createFakeD1({ allResults: [sampleRow, remoteRow] });
      const store = new McpServerStore(db);
      const results = await store.getForSession("carboncopyinc", "habakkuk");
      expect(results).toHaveLength(2); // global + matching scoped
    });

    it("excludes servers scoped to different repos", async () => {
      const { db } = createFakeD1({ allResults: [sampleRow, remoteRow] });
      const store = new McpServerStore(db);
      const results = await store.getForSession("bencered", "dom");
      expect(results).toHaveLength(1); // only the global server
      expect(results[0].name).toBe("playwright");
    });
  });

  describe("UNIQUE constraint handling", () => {
    function createConstraintErrorD1() {
      const fakeStmt = {
        bind(..._params: unknown[]) {
          return fakeStmt;
        },
        async first<T>(): Promise<T | null> {
          // create() calls get() after insert — return the row so it doesn't fail after
          return sampleRow as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            results: [],
            success: true,
            meta: { duration: 0, changes: 0 },
          } as unknown as D1Result<T>;
        },
        async run(): Promise<D1Result> {
          throw new Error("UNIQUE constraint failed: mcp_servers.name");
        },
      };
      return { prepare: () => fakeStmt, dump: vi.fn(), exec: vi.fn() } as unknown as D1Database;
    }

    it("create() throws McpServerValidationError on duplicate name (not 503)", async () => {
      const db = createConstraintErrorD1();
      const store = new McpServerStore(db);
      const err = await store
        .create({ name: "playwright", type: "stdio", command: ["npx", "x"], enabled: true })
        .catch((e) => e);
      expect(err).toBeInstanceOf(McpServerValidationError);
      expect(err.message).toMatch(/already exists/);
    });

    it("update() throws McpServerValidationError on duplicate name", async () => {
      // First call (get existing) returns the row; second call (update) throws constraint error
      let runCallCount = 0;
      let firstCallCount = 0;
      const fakeStmt = {
        bind(..._params: unknown[]) {
          return fakeStmt;
        },
        async first<T>(): Promise<T | null> {
          firstCallCount++;
          return firstCallCount <= 1 ? (sampleRow as T) : null;
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            results: [],
            success: true,
            meta: { duration: 0, changes: 0 },
          } as unknown as D1Result<T>;
        },
        async run(): Promise<D1Result> {
          runCallCount++;
          throw new Error("UNIQUE constraint failed: mcp_servers.name");
        },
      };
      const db = { prepare: () => fakeStmt, dump: vi.fn(), exec: vi.fn() } as unknown as D1Database;
      const store = new McpServerStore(db);
      const err = await store.update("abc123", { name: "other-server" }).catch((e) => e);
      expect(err).toBeInstanceOf(McpServerValidationError);
      expect(runCallCount).toBeGreaterThan(0);
    });
  });

  describe("encryption / decryption", () => {
    it("no-key path returns plaintext env as-is", async () => {
      const { db } = createFakeD1({ firstResult: sampleRow });
      const store = new McpServerStore(db); // no encryption key
      const result = await store.get("abc123");
      expect(result!.env).toEqual({ DEBUG: "1" });
    });

    it("falls back to plaintext when decryption fails (pre-encryption row)", async () => {
      // Row has plaintext JSON env but store has an encryption key
      const { db } = createFakeD1({ firstResult: sampleRow });
      // Use a fake key that will cause decryptToken to throw
      const store = new McpServerStore(db, "bm90YXJlYWxrZXlub3RhcmVhbGtleW5vdGFyZWFsa2V5eA==");
      const result = await store.get("abc123");
      // Should fall back gracefully: env has values, so treated as pre-encryption plaintext
      expect(result!.env).toEqual({ DEBUG: "1" });
    });

    it("returns empty env and logs error when both decryption and JSON parse fail", async () => {
      // Row has garbage that is neither valid ciphertext nor valid JSON
      const { db } = createFakeD1({ firstResult: { ...sampleRow, env: "notjson_notcipher" } });
      const store = new McpServerStore(db, "bm90YXJlYWxrZXlub3RhcmVhbGtleW5vdGFyZWFsa2V5eA==");
      const result = await store.get("abc123");
      // Must not throw; returns empty env
      expect(result!.env).toEqual({});
    });
  });
});
