import { env } from "cloudflare:test";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import {
  BROWSER_AUTH_SESSION_EXPIRES_IN_MS,
  BROWSER_AUTH_SESSION_UPDATE_AGE_MS,
  createBrowserAuth,
} from "../../src/auth/browser-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";
const MS_PER_SECOND = 1000;

const EXPECTED_COLUMNS = {
  auth_users: [
    ["id", "TEXT", 1, 1],
    ["name", "TEXT", 1, 0],
    ["email", "TEXT", 1, 0],
    ["emailVerified", "INTEGER", 1, 0],
    ["image", "TEXT", 0, 0],
    ["createdAt", "DATE", 1, 0],
    ["updatedAt", "DATE", 1, 0],
  ],
  auth_sessions: [
    ["id", "TEXT", 1, 1],
    ["expiresAt", "DATE", 1, 0],
    ["token", "TEXT", 1, 0],
    ["createdAt", "DATE", 1, 0],
    ["updatedAt", "DATE", 1, 0],
    ["ipAddress", "TEXT", 0, 0],
    ["userAgent", "TEXT", 0, 0],
    ["userId", "TEXT", 1, 0],
  ],
  auth_accounts: [
    ["id", "TEXT", 1, 1],
    ["accountId", "TEXT", 1, 0],
    ["providerId", "TEXT", 1, 0],
    ["userId", "TEXT", 1, 0],
    ["accessToken", "TEXT", 0, 0],
    ["refreshToken", "TEXT", 0, 0],
    ["idToken", "TEXT", 0, 0],
    ["accessTokenExpiresAt", "DATE", 0, 0],
    ["refreshTokenExpiresAt", "DATE", 0, 0],
    ["scope", "TEXT", 0, 0],
    ["password", "TEXT", 0, 0],
    ["createdAt", "DATE", 1, 0],
    ["updatedAt", "DATE", 1, 0],
  ],
  auth_verifications: [
    ["id", "TEXT", 1, 1],
    ["identifier", "TEXT", 1, 0],
    ["value", "TEXT", 1, 0],
    ["expiresAt", "DATE", 1, 0],
    ["createdAt", "DATE", 1, 0],
    ["updatedAt", "DATE", 1, 0],
  ],
} as const;

function createTestAuth() {
  return createBrowserAuth({
    database: env.DB,
    publicWebOrigin: PUBLIC_WEB_ORIGIN,
    secret: SECRET,
  });
}

describe("browser authentication", () => {
  it("keeps the static schema aligned with the pinned Better Auth runtime", async () => {
    const migrations = await getMigrations(createTestAuth().options);
    expect(migrations.toBeCreated).toEqual([]);
    expect(migrations.toBeAdded).toEqual([]);

    for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>();
      expect(
        columns.results.map(({ name, type, notnull, pk }) => [name, type, notnull, pk])
      ).toEqual(expectedColumns);
    }

    const providerIdentityIndex = await env.DB.prepare(
      `SELECT "unique"
       FROM pragma_index_list('auth_accounts')
       WHERE name = 'idx_auth_accounts_provider_identity'`
    ).first<{ unique: number }>();
    expect(providerIdentityIndex?.unique).toBe(1);

    const providerIdentityColumns = await env.DB.prepare(
      `SELECT name
       FROM pragma_index_info('idx_auth_accounts_provider_identity')
       ORDER BY seqno`
    ).all<{ name: string }>();
    expect(providerIdentityColumns.results.map(({ name }) => name)).toEqual([
      "providerId",
      "accountId",
    ]);

    for (const table of ["auth_sessions", "auth_accounts"]) {
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>();
      expect(
        foreignKeys.results.map(({ table, from, to, on_delete }) => ({
          table,
          from,
          to,
          onDelete: on_delete,
        }))
      ).toEqual([
        {
          table: "auth_users",
          from: "userId",
          to: "id",
          onDelete: "CASCADE",
        },
      ]);
    }
  });

  it("serves an anonymous session through Better Auth on Workers and D1", async () => {
    const auth = createTestAuth();
    const response = await auth.handler(new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/get-session`));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("uses canonical ids and converts millisecond durations at the library boundary", () => {
    const auth = createTestAuth();
    const generateId = auth.options.advanced?.database?.generateId;

    expect(generateId).toBeTypeOf("function");
    if (typeof generateId !== "function") {
      throw new Error("Better Auth canonical ID generator is not configured");
    }
    expect(generateId({ model: "user" })).toMatch(/^[a-f0-9]{32}$/);
    expect(auth.options.session?.expiresIn).toBe(
      BROWSER_AUTH_SESSION_EXPIRES_IN_MS / MS_PER_SECOND
    );
    expect(auth.options.session?.updateAge).toBe(
      BROWSER_AUTH_SESSION_UPDATE_AGE_MS / MS_PER_SECOND
    );
  });
});
