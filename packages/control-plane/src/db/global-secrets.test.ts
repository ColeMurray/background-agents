import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { GlobalSecretsStore } from "./global-secrets";
import { SecretsValidationError } from "./secrets-validation";
import { generateEncryptionKey } from "../auth/crypto";

let didPolyfillCrypto = false;

beforeAll(() => {
  if (!(globalThis as { crypto?: typeof webcrypto }).crypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    didPolyfillCrypto = true;
  }
});

afterAll(() => {
  if (didPolyfillCrypto) {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  }
});

type GlobalSecretRow = {
  key: string;
  encrypted_value: string;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  SELECT_EXISTING_KEYS: /^SELECT key FROM global_secrets$/,
  SELECT_KEYS_WITH_METADATA: /^SELECT key, created_at, updated_at FROM global_secrets/,
  SELECT_KEYS_WITH_VALUES: /^SELECT key, encrypted_value FROM global_secrets$/,
  UPSERT_SECRET: /^INSERT INTO global_secrets/,
  DELETE_SECRET: /^DELETE FROM global_secrets/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, GlobalSecretRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  all(query: string, _args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_KEYS_WITH_METADATA.test(normalized)) {
      return Array.from(this.rows.values())
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((row) => ({
          key: row.key,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
    }

    if (QUERY_PATTERNS.SELECT_KEYS_WITH_VALUES.test(normalized)) {
      return Array.from(this.rows.values()).map((row) => ({
        key: row.key,
        encrypted_value: row.encrypted_value,
      }));
    }

    if (QUERY_PATTERNS.SELECT_EXISTING_KEYS.test(normalized)) {
      return Array.from(this.rows.values()).map((row) => ({ key: row.key }));
    }

    throw new Error(`Unexpected SELECT query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.UPSERT_SECRET.test(normalized)) {
      const [key, encryptedValue, createdAt, updatedAt] = args as [string, string, number, number];
      const existing = this.rows.get(key);
      const created_at = existing ? existing.created_at : createdAt;
      this.rows.set(key, {
        key,
        encrypted_value: encryptedValue,
        created_at,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE_SECRET.test(normalized)) {
      const [key] = args as [string];
      const existed = this.rows.delete(key);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }

  async batch(statements: FakePreparedStatement[]) {
    return statements.map((stmt) => stmt.runSync());
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

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  runSync() {
    return this.db.run(this.query, this.bound);
  }

  async run() {
    return this.runSync();
  }
}

describe("GlobalSecretsStore", () => {
  let db: FakeD1Database;
  let store: GlobalSecretsStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new GlobalSecretsStore(db as unknown as D1Database, generateEncryptionKey());
  });

  it("encrypts and decrypts values", async () => {
    await store.setSecrets({ FOO: "bar" });
    const secrets = await store.getDecryptedSecrets();
    expect(secrets).toEqual({ FOO: "bar" });
  });

  it("normalizes keys and updates existing secrets", async () => {
    const first = await store.setSecrets({ foo: "one" });
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);

    const second = await store.setSecrets({ FOO: "two" });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const secrets = await store.getDecryptedSecrets();
    expect(secrets).toEqual({ FOO: "two" });
  });

  it("rejects reserved keys", async () => {
    await expect(store.setSecrets({ PATH: "nope" })).rejects.toBeInstanceOf(SecretsValidationError);
  });

  it("rejects invalid key patterns", async () => {
    await expect(store.setSecrets({ "1BAD": "nope" })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces value size limits", async () => {
    const bigValue = "a".repeat(16385);
    await expect(store.setSecrets({ BIG: bigValue })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces total size limits", async () => {
    const largeA = "a".repeat(40000);
    const largeB = "b".repeat(30000);
    await expect(store.setSecrets({ A: largeA, B: largeB })).rejects.toBeInstanceOf(
      SecretsValidationError
    );
  });

  it("enforces per-scope secret limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      many[`KEY_${i}`] = "x";
    }
    await store.setSecrets(many);

    await expect(store.setSecrets({ EXTRA: "y" })).rejects.toBeInstanceOf(SecretsValidationError);
  });

  it("lists keys with metadata", async () => {
    await store.setSecrets({ ALPHA: "1", BETA: "2" });
    const keys = await store.listSecretKeys();
    expect(keys.map((k) => k.key)).toEqual(["ALPHA", "BETA"]);
    expect(keys[0].createdAt).toBeTypeOf("number");
  });

  it("deletes secrets by key", async () => {
    await store.setSecrets({ ALPHA: "1" });
    const deleted = await store.deleteSecret("alpha");
    expect(deleted).toBe(true);
    const secrets = await store.getDecryptedSecrets();
    expect(secrets).toEqual({});
  });

  it("returns false when deleting nonexistent key", async () => {
    const deleted = await store.deleteSecret("NOPE");
    expect(deleted).toBe(false);
  });
});
