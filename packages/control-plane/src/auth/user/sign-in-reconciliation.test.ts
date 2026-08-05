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
}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
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
    return stmt;
  }

  const db: SqlDatabase = {
    prepare(sql: string) {
      return statement(sql);
    },
    async batch(batchStatements: SqlStatement[]) {
      if (options?.throwOn === "batch") throw new Error("D1 batch failed");
      batches.push(
        batchStatements.map(() => statements[statements.length - 1] ?? { sql: "", params: [] })
      );
      return batchStatements.map(() => ({ results: [], meta: { changes: 1 } }));
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
