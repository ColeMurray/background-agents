/**
 * Unit tests for UserEnvResolver.
 *
 * The resolver is exercised against a real SessionCoreRepository over a fake
 * DO SqlStorage and real secret stores over a fake SqlDatabase (real AES-GCM
 * round-trips via encryptToken), so these tests pin the observable throw and
 * return surface rather than the fakes.
 */

import { describe, it, expect } from "vitest";
import { UserEnvResolver } from "./user-env-resolver";
import { resolveSessionRepoId } from "./repo-id-resolution";
import {
  MAX_COMBINED_SECRETS_BYTES,
  MAX_TOTAL_VALUE_SIZE,
  MAX_VALUE_SIZE,
  SecretsCapExceededError,
} from "../db/secrets-validation";
import { SessionCoreRepository } from "./session-core-repository";
import { encryptToken, generateEncryptionKey } from "../auth/crypto";
import type { Logger } from "../logger";
import type { SqlDatabase, SqlResult, SqlStatement } from "../db/sql-database";
import type { SqlResult as StorageSqlResult, SqlStorage } from "./sql-storage";
import type { SessionProviderAuthMode } from "@open-inspect/shared/types/provider-accounts";
import type { SessionRepositoryRow, SessionRow } from "./types";

const ENCRYPTION_KEY = generateEncryptionKey();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const push = (level: LogEntry["level"]) => (msg: string, data?: Record<string, unknown>) => {
    entries.push({ level, msg, data });
  };
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => recordingLogger(entries),
  };
}

function notUsedHere(member: string): never {
  throw new Error(`${member} is not exercised by the user-env-resolver suite`);
}

/** DO-embedded SQLite fake backing a real SessionCoreRepository. */
function fakeSqlStorage(state: { session: SessionRow | null; memberRows: SessionRepositoryRow[] }) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): StorageSqlResult {
      calls.push({ query, params });
      let rows: unknown[] = [];
      if (query === "SELECT * FROM session LIMIT 1") {
        rows = state.session ? [state.session] : [];
      } else if (query === "SELECT * FROM session_repositories ORDER BY position") {
        rows = state.memberRows;
      } else if (!query.startsWith("UPDATE session SET repo_id")) {
        throw new Error(`Unexpected DO storage query: ${query}`);
      }
      return { toArray: () => rows, one: () => rows[0] ?? null, rowsWritten: 1 };
    },
  };
  return { sql, calls };
}

type D1Row = Record<string, unknown>;

class FakeStatement implements SqlStatement {
  private bound: unknown[] = [];

  constructor(
    private readonly db: FakeSqlDatabase,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): SqlStatement {
    this.bound = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return Promise.reject(new Error(`first() is not used by the resolver: ${this.query}`));
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return Promise.reject(new Error(`run() is not used by the resolver: ${this.query}`));
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows: unknown[] = this.db.rowsFor(this.query, this.bound);
    return { results: rows as T[], meta: { changes: 0 } };
  }
}

/** Read-only D1 fake covering exactly the queries the resolver's stores run. */
class FakeSqlDatabase implements SqlDatabase {
  readonly queries: string[] = [];
  readonly providerAuthBinds: unknown[] = [];
  providerAuthRows: D1Row[] = [];
  globalSecretRows: D1Row[] = [];
  readonly repoSecretRowsByRepoId = new Map<number, D1Row[]>();
  readonly environmentSecretRowsById = new Map<string, D1Row[]>();

  prepare(query: string): SqlStatement {
    return new FakeStatement(this, query.replace(/\s+/g, " ").trim());
  }

  batch<T = unknown>(): Promise<SqlResult<T>[]> {
    return Promise.reject(new Error("batch() is not used by the resolver"));
  }

  rowsFor(query: string, bound: unknown[]): D1Row[] {
    this.queries.push(query);
    if (query.startsWith("SELECT provider, auth_mode")) {
      this.providerAuthBinds.push(bound[0]);
      return this.providerAuthRows;
    }
    if (query === "SELECT key, encrypted_value FROM global_secrets") {
      return this.globalSecretRows;
    }
    if (query === "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?") {
      return this.repoSecretRowsByRepoId.get(bound[0] as number) ?? [];
    }
    if (query === "SELECT key, encrypted_value FROM environment_secrets WHERE environment_id = ?") {
      return this.environmentSecretRowsById.get(bound[0] as string) ?? [];
    }
    throw new Error(`Unexpected D1 query: ${query}`);
  }
}

async function secretRows(secrets: Record<string, string>): Promise<D1Row[]> {
  const rows: D1Row[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    rows.push({ key, encrypted_value: await encryptToken(value, ENCRYPTION_KEY) });
  }
  return rows;
}

function providerAuthRows(modes: {
  openai: SessionProviderAuthMode;
  xai: SessionProviderAuthMode;
}): D1Row[] {
  return (["openai", "xai"] as const).map((provider) => ({
    provider,
    auth_mode: modes[provider],
    provider_account_id: modes[provider] === "provider_account" ? "1".repeat(32) : null,
    selection_source: "explicit",
    inherited_from_session_id: null,
  }));
}

const API_KEY_MODES = { openai: "api_key", xai: "api_key" } as const;

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    session_name: "sess-public-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 90101,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function memberRow(
  position: number,
  repoOwner: string,
  repoName: string,
  repoId: number | null
): SessionRepositoryRow {
  return {
    position,
    repo_owner: repoOwner,
    repo_name: repoName,
    repo_id: repoId,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
  };
}

function makeHarness(
  options: {
    session?: SessionRow | null;
    memberRows?: SessionRepositoryRow[];
    /** Model a deployment where the DB binding is missing. */
    withoutDb?: boolean;
    /** Defaults to ENCRYPTION_KEY — the key is required in production. */
    encryptionKey?: string;
    /** Omit to model an unset SECRETS_CAP_ENFORCEMENT (fail-closed enforce). */
    capEnforcement?: string;
    resolveRepoId?: (session: SessionRow) => Promise<number>;
  } = {}
) {
  const session = options.session === undefined ? sessionRow() : options.session;
  const storage = fakeSqlStorage({ session, memberRows: options.memberRows ?? [] });
  const db = new FakeSqlDatabase();
  const logs: LogEntry[] = [];
  const log = recordingLogger(logs);
  const sessionCoreRepository = new SessionCoreRepository(storage.sql, (closure) => closure());
  let resolveRepoIdCalls = 0;
  // Default mirrors production wiring: the real resolution function over a
  // provider thunk that throws, so short-circuits work and any path that
  // would construct the SCM provider fails the test loudly.
  const resolveRepoId =
    options.resolveRepoId ??
    ((sessionForRepoId: SessionRow) =>
      resolveSessionRepoId(sessionForRepoId, sessionCoreRepository, () =>
        notUsedHere("sourceControlProvider")
      ));

  const resolver = new UserEnvResolver({
    db: options.withoutDb ? null : db,
    sessionCoreRepository,
    resolveRepoId: (sessionForRepoId) => {
      resolveRepoIdCalls += 1;
      return resolveRepoId(sessionForRepoId);
    },
    durableObjectId: "do-id-fallback",
    repoSecretsEncryptionKey: options.encryptionKey ?? ENCRYPTION_KEY,
    secretsCapEnforcement: options.capEnforcement,
    log,
  });

  return {
    resolver,
    db,
    logs,
    sqlCalls: storage.calls,
    resolveRepoIdCalls: () => resolveRepoIdCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserEnvResolver", () => {
  describe("missing session row", () => {
    it("returns undefined from getUserEnvVars after a warn, without touching D1", async () => {
      const h = makeHarness({ session: null });

      await expect(h.resolver.getUserEnvVars()).resolves.toBeUndefined();

      expect(h.logs).toContainEqual({
        level: "warn",
        msg: "Cannot load secrets: no session",
        data: undefined,
      });
      expect(h.db.queries).toEqual([]);
    });

    it("returns null from getProviderAuthenticationError", async () => {
      const h = makeHarness({ session: null });

      await expect(h.resolver.getProviderAuthenticationError("openai/gpt-5")).resolves.toBeNull();
    });
  });

  it("throws when a session exists but D1 is unavailable", async () => {
    const h = makeHarness({ withoutDb: true });

    await expect(h.resolver.getUserEnvVars()).rejects.toThrow(
      "D1 is required to load session provider auth"
    );
  });

  describe("with no stored secrets", () => {
    it("returns undefined (not {}) when no provider is managed", async () => {
      const h = makeHarness();
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);

      await expect(h.resolver.getUserEnvVars()).resolves.toBeUndefined();
    });
  });

  describe("session-target secret fold", () => {
    async function foldHarness(
      secondarySecrets: Record<string, string>,
      primarySecrets: Record<string, string>
    ) {
      const h = makeHarness({
        memberRows: [memberRow(0, "acme", "web", 90101), memberRow(1, "acme", "backend", 90102)],
        encryptionKey: ENCRYPTION_KEY,
      });
      h.db.providerAuthRows = providerAuthRows({ openai: "api_key", xai: "legacy_scoped_oauth" });
      h.db.globalSecretRows = await secretRows({ SHARED: "global", ONLY_GLOBAL: "g" });
      h.db.repoSecretRowsByRepoId.set(90101, await secretRows(primarySecrets));
      h.db.repoSecretRowsByRepoId.set(90102, await secretRows(secondarySecrets));
      return h;
    }

    it("folds members with the primary winning, and excludes secondary repos from the managed broker env", async () => {
      const h = await foldHarness(
        { SHARED: "backend", ONLY_BACKEND: "b", XAI_OAUTH_REFRESH_TOKEN: "legacy-xai" },
        { SHARED: "web", ONLY_WEB: "w" }
      );

      // The secondary's legacy OAuth token is stripped from the exposed env and,
      // because only global + primary feed broker secrets, does NOT mark xai managed.
      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({
        SHARED: "web",
        ONLY_GLOBAL: "g",
        ONLY_WEB: "w",
        ONLY_BACKEND: "b",
      });
    });

    it("marks a provider managed when the legacy token comes from the primary repo", async () => {
      const h = await foldHarness(
        { SHARED: "backend", ONLY_BACKEND: "b" },
        { SHARED: "web", ONLY_WEB: "w", XAI_OAUTH_REFRESH_TOKEN: "legacy-xai" }
      );

      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({
        SHARED: "web",
        ONLY_GLOBAL: "g",
        ONLY_WEB: "w",
        ONLY_BACKEND: "b",
        XAI_OAUTH_MANAGED: "1",
      });
    });

    it("returns undefined (not {}) when every source is empty", async () => {
      const h = makeHarness({ encryptionKey: ENCRYPTION_KEY });
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);

      await expect(h.resolver.getUserEnvVars()).resolves.toBeUndefined();
    });

    it("sources environment secrets without the member filter and never reads repo secrets", async () => {
      const h = makeHarness({
        session: sessionRow({ environment_id: "env-1" }),
        encryptionKey: ENCRYPTION_KEY,
      });
      h.db.providerAuthRows = providerAuthRows({ openai: "api_key", xai: "legacy_scoped_oauth" });
      h.db.globalSecretRows = await secretRows({ SHARED: "global", ONLY_GLOBAL: "g" });
      h.db.environmentSecretRowsById.set(
        "env-1",
        await secretRows({ SHARED: "env", FROM_ENV: "e", XAI_OAUTH_REFRESH_TOKEN: "legacy-xai" })
      );

      // Environment sources also feed the broker env, so the legacy token marks xai managed.
      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({
        SHARED: "env",
        ONLY_GLOBAL: "g",
        FROM_ENV: "e",
        XAI_OAUTH_MANAGED: "1",
      });
      expect(h.db.queries.some((query) => query.includes("repo_secrets"))).toBe(false);
    });

    it("skips a secondary member with no resolvable repo id without touching the provider", async () => {
      const h = makeHarness({
        memberRows: [memberRow(0, "acme", "web", 90101), memberRow(1, "acme", "backend", null)],
        encryptionKey: ENCRYPTION_KEY,
      });
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);
      h.db.globalSecretRows = await secretRows({ ONLY_GLOBAL: "g" });
      h.db.repoSecretRowsByRepoId.set(90101, await secretRows({ ONLY_WEB: "w" }));

      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({
        ONLY_GLOBAL: "g",
        ONLY_WEB: "w",
      });

      // The id-less secondary contributes nothing: exactly one repo_secrets read
      // (the primary's) and no lazy repo-id resolution.
      expect(h.db.queries.filter((query) => query.includes("repo_secrets"))).toHaveLength(1);
      expect(h.resolveRepoIdCalls()).toBe(0);
    });

    it("resolves the repo id lazily for a legacy primary member row", async () => {
      const h = makeHarness({
        memberRows: [memberRow(0, "acme", "web", null)],
        encryptionKey: ENCRYPTION_KEY,
        resolveRepoId: async () => 90101,
      });
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);
      h.db.repoSecretRowsByRepoId.set(90101, await secretRows({ ONLY_WEB: "w" }));

      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({ ONLY_WEB: "w" });

      // The primary's null row id routes through the injected capability, and
      // the id it returns keys the repo-secrets read.
      expect(h.resolveRepoIdCalls()).toBe(1);
    });

    it("resolves repo secrets without constructing the source control provider", async () => {
      const h = makeHarness({ encryptionKey: ENCRYPTION_KEY });
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);
      h.db.globalSecretRows = await secretRows({ FOO: "bar" });
      h.db.repoSecretRowsByRepoId.set(90101, await secretRows({ BAZ: "qux" }));

      await expect(h.resolver.getUserEnvVars()).resolves.toEqual({ FOO: "bar", BAZ: "qux" });

      // The synthesized primary (no member rows) routes through the capability
      // once, which short-circuits on the session's repo_id; the harness
      // default throws if the provider thunk is ever invoked.
      expect(h.resolveRepoIdCalls()).toBe(1);
    });
  });

  describe("secrets cap", () => {
    // Every scope must be reachable through the production write path: each
    // value within MAX_VALUE_SIZE and each scope within MAX_TOTAL_VALUE_SIZE.
    // Three individually valid scopes together exceed the combined cap.
    const CAP_VALUE = "x".repeat(MAX_VALUE_SIZE / 2);
    const PER_SCOPE_COUNT = 6;
    const SCOPE_COUNT = 3;
    const TOTAL_KEYS = PER_SCOPE_COUNT * SCOPE_COUNT;

    function bulkScope(prefix: string): Record<string, string> {
      return Object.fromEntries(
        Array.from({ length: PER_SCOPE_COUNT }, (_, i) => [`${prefix}_${i}`, CAP_VALUE])
      );
    }

    async function overCapHarness(capEnforcement?: string) {
      expect(PER_SCOPE_COUNT * CAP_VALUE.length).toBeLessThanOrEqual(MAX_TOTAL_VALUE_SIZE);
      expect(TOTAL_KEYS * CAP_VALUE.length).toBeGreaterThan(MAX_COMBINED_SECRETS_BYTES);

      const h = makeHarness({
        memberRows: [memberRow(0, "acme", "web", 90101), memberRow(1, "acme", "backend", 90102)],
        encryptionKey: ENCRYPTION_KEY,
        capEnforcement,
      });
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);
      h.db.globalSecretRows = await secretRows(bulkScope("BULK_G"));
      h.db.repoSecretRowsByRepoId.set(90101, await secretRows(bulkScope("BULK_A")));
      h.db.repoSecretRowsByRepoId.set(90102, await secretRows(bulkScope("BULK_B")));
      return h;
    }

    it("rejects an over-cap payload when enforcement is unset (fail closed)", async () => {
      const h = await overCapHarness();

      await expect(h.resolver.getUserEnvVars()).rejects.toThrow(SecretsCapExceededError);

      expect(h.logs).toContainEqual(
        expect.objectContaining({ level: "error", msg: "secrets.cap_exceeded" })
      );
    });

    it("resolves the oversized payload in warn mode and logs the breach", async () => {
      const h = await overCapHarness("warn");

      const env = await h.resolver.getUserEnvVars();

      expect(Object.keys(env ?? {})).toHaveLength(TOTAL_KEYS);
      expect(h.logs).toContainEqual(
        expect.objectContaining({ level: "warn", msg: "secrets.cap_exceeded" })
      );
    });
  });

  describe("getProviderAuthenticationError", () => {
    it("returns the provider message and logs when authentication is unavailable", async () => {
      const h = makeHarness();
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);

      await expect(
        h.resolver.getProviderAuthenticationError("openai/gpt-5-codex")
      ).resolves.toMatch(/No OpenAI authentication is configured/);

      expect(h.logs).toContainEqual({
        level: "error",
        msg: "provider_auth.unavailable",
        data: { event: "provider_auth.unavailable", provider: "openai", auth_mode: "api_key" },
      });
    });

    it("returns null when the provider is authenticated", async () => {
      const h = makeHarness();
      h.db.providerAuthRows = providerAuthRows({ openai: "provider_account", xai: "api_key" });

      await expect(h.resolver.getProviderAuthenticationError("openai/gpt-5")).resolves.toBeNull();
    });

    it("returns null for non-subscription providers", async () => {
      const h = makeHarness();
      h.db.providerAuthRows = providerAuthRows(API_KEY_MODES);

      await expect(
        h.resolver.getProviderAuthenticationError("anthropic/claude-sonnet-4-5")
      ).resolves.toBeNull();
    });
  });
});
