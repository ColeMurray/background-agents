import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { D1AccountIdentityProjection } from "./account-identity-projection";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface RecordedStatement {
  sql: string;
  params: unknown[];
}

function createFakeDb(options?: {
  firstResult?: Record<string, unknown> | null;
  changes?: number;
  throwOn?: "prepare" | "run" | "first";
}) {
  const statements: RecordedStatement[] = [];

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
        return (options?.firstResult ?? null) as T | null;
      },
      async run<T>() {
        if (options?.throwOn === "run") throw new Error("D1 run failed");
        return { results: [] as T[], meta: { changes: options?.changes ?? 1 } };
      },
      async all<T>() {
        return { results: [] as T[], meta: { changes: 0 } };
      },
    };
    return stmt;
  }

  const db: SqlDatabase = {
    prepare(sql: string) {
      if (options?.throwOn === "prepare") throw new Error("D1 prepare failed");
      return statement(sql);
    },
    async batch() {
      return [];
    },
  };

  return { db, statements };
}

const ACCOUNT = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  accountId: "583231",
  providerId: "github",
  userId: "11111111111111111111111111111111",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D1AccountIdentityProjection", () => {
  it("projects a sign-in provider account into user_identities with its issuer", async () => {
    const { db, statements } = createFakeDb();
    const projection = new D1AccountIdentityProjection(db);

    await projection.project(ACCOUNT);

    const insert = statements.find((entry) => entry.sql.includes("INSERT INTO user_identities"));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain("ON CONFLICT");
    expect(insert?.params).toContain("github");
    expect(insert?.params).toContain("583231");
    expect(insert?.params).toContain("https://github.com");
    expect(insert?.params).toContain(ACCOUNT.userId);
    expect(insert?.params).toContain(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("skips providers that are not sign-in providers", async () => {
    const { db, statements } = createFakeDb();
    const projection = new D1AccountIdentityProjection(db);

    await projection.project({ ...ACCOUNT, providerId: "credential" });

    expect(statements).toHaveLength(0);
  });

  it("does not insert when the identity already exists for the same user", async () => {
    const { db, statements } = createFakeDb({ firstResult: { user_id: ACCOUNT.userId } });
    const projection = new D1AccountIdentityProjection(db);

    await projection.project(ACCOUNT);

    expect(statements.some((entry) => entry.sql.includes("INSERT"))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits a conflict event when the subject is owned by a different canonical user", async () => {
    const { db, statements } = createFakeDb({
      firstResult: { user_id: "22222222222222222222222222222222" },
    });
    const projection = new D1AccountIdentityProjection(db);

    await projection.project(ACCOUNT);

    expect(statements.some((entry) => entry.sql.includes("INSERT"))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("auth.identity_projection_conflict");
  });

  it("swallows database failures so sign-in never fails on bookkeeping", async () => {
    const { db } = createFakeDb({ throwOn: "run" });
    const projection = new D1AccountIdentityProjection(db);

    await expect(projection.project(ACCOUNT)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("auth.identity_projection_failed");
  });
});
