import { env } from "cloudflare:test";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { createBrowserAuth } from "../../src/auth/browser-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";

describe("browser authentication", () => {
  it("serves an anonymous session through Better Auth on Workers and D1", async () => {
    const auth = createBrowserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
    });
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();

    const response = await auth.handler(new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/get-session`));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });
});
