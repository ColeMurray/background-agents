import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../../src/node/sqlite-database";
import { createUserAuth } from "../../src/auth/user/better-auth";
import { seedBrowserSession, type BrowserSessionSeed } from "./browser-session";

describe("portable browser sessions against the actual Better Auth reader", () => {
  let dir: string | undefined;
  let db: NodeSqlDatabase | undefined;
  afterEach(async () => {
    db?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it.each(["http://127.0.0.1:3000", "https://preview.test"])(
    "derives cookie policy and verifies signatures on %s",
    async (publicWebOrigin) => {
      dir = await mkdtemp(join(tmpdir(), "oi-auth-test-"));
      db = openNodeSqlDatabase(join(dir, "test.db"), {
        migrationsDir: resolve(import.meta.dirname, "../../../../terraform/d1/migrations"),
      });
      const secret = randomBytes(32).toString("base64");
      const seed: BrowserSessionSeed = {
        userId: "a".repeat(32),
        identityId: "test-identity",
        providerSubject: "90001",
        name: "Test member",
        email: "member@preview.test",
        role: "member",
        sessionId: "test-session",
        token: "test-token",
        nowMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
      const fixture = await seedBrowserSession(db, { publicWebOrigin, secret }, seed);
      const cookie = fixture.storageState.cookies[0];
      expect(cookie.secure).toBe(publicWebOrigin.startsWith("https:"));
      expect(cookie.name).toBe(`${cookie.secure ? "__Secure-" : ""}openinspect.session_token`);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      const auth = createUserAuth({ database: db, publicWebOrigin, secret });
      const read = (cookieHeader: string) =>
        auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) });
      expect((await read(fixture.cookieHeader))?.user.id).toBe(seed.userId);
      expect(await read(`${cookie.name}=tampered`)).toBeNull();
      const wrong = await seedBrowserSession(
        db,
        { publicWebOrigin, secret: randomBytes(32).toString("base64") },
        seed
      );
      expect(await read(wrong.cookieHeader)).toBeNull();
      await db
        .prepare("UPDATE auth_sessions SET expiresAt = ?")
        .bind(Date.now() - 1000)
        .run();
      expect(await read(fixture.cookieHeader)).toBeNull();
    }
  );
});
