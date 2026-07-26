import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createBrowserAuth } from "../../src/auth/browser-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";

describe("browser authentication", () => {
  it("uses the static auth schema with a unique provider identity", async () => {
    const tables = await env.DB.prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name IN ('auth_users', 'auth_accounts', 'auth_sessions', 'auth_verifications')
       ORDER BY name`
    ).all<{ name: string }>();

    expect(tables.results.map(({ name }) => name)).toEqual([
      "auth_accounts",
      "auth_sessions",
      "auth_users",
      "auth_verifications",
    ]);

    const providerIdentityIndex = await env.DB.prepare(
      `SELECT "unique"
       FROM pragma_index_list('auth_accounts')
       WHERE name = 'idx_auth_accounts_provider_identity'`
    ).first<{ unique: number }>();
    expect(providerIdentityIndex?.unique).toBe(1);
  });

  it("serves an anonymous session through Better Auth on Workers and D1", async () => {
    const auth = createBrowserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
    });
    const response = await auth.handler(new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/get-session`));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });
});
