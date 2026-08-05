import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "../../db/sql-database";
import type { ProviderProfile } from "./provider-profile";
import { SignInReconciliation } from "./sign-in-reconciliation";

interface RecordedStatement {
  sql: string;
  params: unknown[];
}

function createFakeDb(options?: {
  firstResults?: (Record<string, unknown> | null)[];
  throwOn?: "first" | "batch" | "run";
  /** Per-statement `meta.changes` for batch results (defaults to 1 each). */
  batchChanges?: number[];
}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const recordsByStatement = new WeakMap<SqlStatement, RecordedStatement>();
  let firstCallIndex = 0;

  function statement(sql: string): SqlStatement {
    const recorded: RecordedStatement = { sql, params: [] };
    statements.push(recorded);
    const stmt: SqlStatement = {
      bind(...values: unknown[]) {
        recorded.params = values;
        return stmt;
      },
      async first<T>() {
        if (options?.throwOn === "first") throw new Error("D1 first failed");
        const result = options?.firstResults?.[firstCallIndex] ?? null;
        firstCallIndex += 1;
        return result as T | null;
      },
      async run<T>() {
        if (options?.throwOn === "run") throw new Error("D1 run failed");
        return { results: [] as T[], meta: { changes: 1 } };
      },
      async all<T>() {
        return { results: [] as T[], meta: { changes: 0 } };
      },
    };
    recordsByStatement.set(stmt, recorded);
    return stmt;
  }

  const db: SqlDatabase = {
    prepare(sql: string) {
      return statement(sql);
    },
    async batch(batchStatements: SqlStatement[]) {
      if (options?.throwOn === "batch") throw new Error("D1 batch failed");
      batches.push(
        batchStatements.map((entry) => recordsByStatement.get(entry) ?? { sql: "", params: [] })
      );
      return batchStatements.map((_, index) => ({
        results: [],
        meta: { changes: options?.batchChanges?.[index] ?? 1 },
      }));
    },
  };

  return { db, statements, batches };
}

const PROFILE: ProviderProfile = {
  user: {
    id: "583231",
    name: "The Octocat",
    email: "octocat@example.com",
    image: "https://avatars.example/octocat",
    emailVerified: true,
  },
  data: {},
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SignInReconciliation", () => {
  it("returns the inner profile unchanged and passes tokens through", async () => {
    const { db } = createFakeDb();
    const reconciliation = new SignInReconciliation(db);
    const inner = vi.fn().mockResolvedValue(PROFILE);
    const wrapped = reconciliation.wrapResolver("github", inner);

    const tokens = { accessToken: "token" };
    const result = await wrapped(tokens);

    expect(inner).toHaveBeenCalledWith(tokens);
    expect(result).toBe(PROFILE);
  });

  it("passes a null inner result through without touching the database", async () => {
    const { db, statements } = createFakeDb();
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => null);

    expect(await wrapped({})).toBeNull();
    expect(statements).toHaveLength(0);
  });

  it("does nothing without a verified email (auth_users.email is NOT NULL)", async () => {
    const { db, statements } = createFakeDb();
    const reconciliation = new SignInReconciliation(db);
    const unverified: ProviderProfile = {
      user: { ...PROFILE.user, emailVerified: false },
      data: {},
    };
    const wrapped = reconciliation.wrapResolver("github", async () => unverified);

    expect(await wrapped({})).toBe(unverified);
    expect(statements).toHaveLength(0);
  });

  it("skips both tiers when the subject already has an auth account (fast path)", async () => {
    const { db, statements, batches } = createFakeDb({
      firstResults: [{ userId: "11111111111111111111111111111111" }],
    });
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => PROFILE);

    expect(await wrapped({})).toBe(PROFILE);
    expect(statements).toHaveLength(1);
    expect(batches).toHaveLength(0);
  });

  it("returns the inner profile unchanged when the database throws (constraint 7)", async () => {
    const { db } = createFakeDb({ throwOn: "first" });
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => PROFILE);

    await expect(wrapped({})).resolves.toBe(PROFILE);
    expect(errorSpy).toHaveBeenCalled();
    const events = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      events.some((entry: string) => entry.includes("auth.subject_materialization_failed"))
    ).toBe(true);
    expect(events.some((entry: string) => entry.includes("auth.email_tier_failed"))).toBe(true);
  });

  it("falls through to the email tier when the materialization batch fails", async () => {
    const { db, statements } = createFakeDb({
      firstResults: [
        null, // no auth account for the subject
        { user_id: "11111111111111111111111111111111" }, // identity match
        { count: 0 }, // target auth user bears no accounts
        null, // no canonical owner of the email
        null, // no auth owner of the email
        null, // email tier: no canonical owner -> register proceeds
      ],
      throwOn: "batch",
    });
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => PROFILE);

    await expect(wrapped({})).resolves.toBe(PROFILE);

    const events = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      events.some((entry: string) => entry.includes("auth.subject_materialization_failed"))
    ).toBe(true);
    expect(events.some((entry: string) => entry.includes("auth.email_tier_failed"))).toBe(false);
    // The email tier's canonical-owner lookup ran after the batch failure.
    const ownerLookups = statements.filter((entry) =>
      entry.sql.includes("SELECT id FROM users WHERE email IS NOT NULL")
    );
    expect(ownerLookups.length).toBe(2);
  });

  it("enforces the zero-account invariant inside the writes, not just the read", async () => {
    const { db, batches } = createFakeDb({
      firstResults: [
        null, // no auth account for the subject
        { user_id: "11111111111111111111111111111111" }, // identity match
        { count: 0 }, // target auth user bears no accounts (stale read)
        null, // no canonical owner of the email
        null, // no auth owner of the email
      ],
    });
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => PROFILE);
    await wrapped({});

    expect(batches).toHaveLength(1);
    const accountInsert = batches[0].find((entry) =>
      entry.sql.includes("INSERT INTO auth_accounts")
    );
    // The INSERT re-checks the invariant so a concurrent attach between the
    // COUNT read and the batch cannot bypass Better Auth's linking gate.
    expect(accountInsert?.sql).toContain("WHERE NOT EXISTS");
    expect(accountInsert?.sql).toContain("ON CONFLICT DO NOTHING");
    // The batch fake records real statements — the repair UPDATE keeps its
    // own zero-account guard.
    const repairUpdate = batches[0].find((entry) => entry.sql.includes("UPDATE OR IGNORE"));
    expect(repairUpdate?.sql).toContain("NOT EXISTS");
  });

  it("falls through to the email tier when a concurrent callback attached an account first", async () => {
    const { db, statements } = createFakeDb({
      firstResults: [
        null, // no auth account for the subject
        { user_id: "11111111111111111111111111111111" }, // identity match
        { count: 0 }, // stale zero-account read
        null, // no canonical owner of the email
        null, // no auth owner of the email
        null, // email tier: no canonical owner
      ],
      // auth_users insert applied, repair skipped, account INSERT skipped by
      // its in-write guard (a concurrent callback attached first), users
      // update skipped.
      batchChanges: [1, 0, 0, 0],
    });
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => PROFILE);

    await expect(wrapped({})).resolves.toBe(PROFILE);

    // Materialization did not complete, so the email tier ran.
    const ownerLookups = statements.filter((entry) =>
      entry.sql.includes("SELECT id FROM users WHERE email IS NOT NULL")
    );
    expect(ownerLookups.length).toBe(2);
    const events = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(events.some((entry: string) => entry.includes("failed"))).toBe(false);
  });

  it("propagates inner resolver failures untouched (admission errors must keep failing sign-in)", async () => {
    const { db, statements } = createFakeDb();
    const reconciliation = new SignInReconciliation(db);
    const wrapped = reconciliation.wrapResolver("github", async () => {
      throw new Error("admission denied");
    });

    await expect(wrapped({})).rejects.toThrow("admission denied");
    expect(statements).toHaveLength(0);
  });
});
