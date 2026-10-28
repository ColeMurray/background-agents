import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase } from "../../node/sqlite-database";
import { resolveGitHubAccountProfile } from "../../source-control/github-credential-authority";
import type { Env } from "../../types";
import { AdmissionDeniedError } from "./admission-policy";
import { OAuthProviderError } from "./providers/types";
import { createUserAuthRuntimeFromEnv } from "./runtime";
import type { SqlDatabase, SqlStatement } from "../../db/sql-database";
import { createUserAuth } from "./better-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";
const UNUSED_PROFILE_RESOLVER = async () => null;

/** Provider rejection happens before any query executes. */
const UNREACHED_DATABASE: SqlDatabase = {
  prepare(): SqlStatement {
    throw new Error("Database access is not expected in this test");
  },
  batch(): never {
    throw new Error("Database access is not expected in this test");
  },
};

describe("Better Auth provider execution", () => {
  it("rejects a provider that is disabled before sign-in executes", async () => {
    const auth = createUserAuth({
      database: UNREACHED_DATABASE,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    await expect(
      auth.api.signInSocial({
        body: {
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        },
        headers: new Headers({ Origin: PUBLIC_WEB_ORIGIN }),
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      body: {
        code: "PROVIDER_NOT_FOUND",
      },
    });
  });
});

describe("Better Auth internal account lookups", () => {
  it("reads existing 1.6.25 credentials and session cookies without rewriting identities", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const database = createNodeSqlDatabase(sqlite);
    applyMigrations(
      sqlite,
      fileURLToPath(new NodeURL("../../../../../terraform/d1/migrations", import.meta.url))
    );
    const userId = "11111111111111111111111111111111";
    const accountId = "22222222222222222222222222222222";
    const nowMs = Date.now();
    // Generated with better-auth@1.6.25 symmetricEncrypt using SECRET, not the
    // version under test. This fixture must remain readable across the upgrade.
    const encryptedToken =
      "9b656aa06c536b7b8135704732d59ab8ce61c6c5ccd608bf701e3fb9ab1e7ec62748bfdc001873d39006361c9d81202425de29ac17554890559e47";
    const sessionToken = "existing-browser-session";
    const signature = createHmac("sha256", SECRET).update(sessionToken).digest("base64");
    const headers = new Headers({
      Cookie: `__Secure-openinspect.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`,
      Origin: PUBLIC_WEB_ORIGIN,
    });
    try {
      await database.batch([
        database
          .prepare(
            "INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)"
          )
          .bind(userId, "octocat@example.com", nowMs, nowMs),
        database
          .prepare(
            "INSERT INTO user_identities (id, user_id, provider, provider_user_id, created_at, updated_at, access_token) VALUES (?, ?, 'github', '583231', ?, ?, ?)"
          )
          .bind(accountId, userId, nowMs, nowMs, encryptedToken),
        database
          .prepare(
            "INSERT INTO auth_sessions (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind("existing-session-id", userId, sessionToken, nowMs + 3_600_000, nowMs, nowMs),
      ]);
      const auth = createUserAuth({
        database,
        publicWebOrigin: PUBLIC_WEB_ORIGIN,
        secret: SECRET,
        github: {
          clientId: "github-client-id",
          clientSecret: "github-client-secret",
          getUserInfo: UNUSED_PROFILE_RESOLVER,
        },
      });
      await expect(auth.api.getSession({ headers })).resolves.toMatchObject({
        user: { id: userId },
      });
      await expect(auth.api.getAccessToken({ body: { accountId, userId } })).resolves.toMatchObject(
        { accessToken: "github-access-token" }
      );
      await expect(
        auth.api.getAccessToken({ body: { accountId, userId: "another-user" } })
      ).rejects.toMatchObject({ body: { code: "ACCOUNT_NOT_FOUND" } });
      await auth.api.signOut({ headers });
      await expect(auth.api.getSession({ headers })).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it.each(["admission", "integrity"] as const)(
    "preserves hard %s errors after a browser callback",
    async (failure) => {
      const sqlite = new DatabaseSync(":memory:");
      const database = createNodeSqlDatabase(sqlite);
      applyMigrations(
        sqlite,
        fileURLToPath(new NodeURL("../../../../../terraform/d1/migrations", import.meta.url))
      );
      let malformedIdentity = false;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "github-access-token", token_type: "bearer" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: malformedIdentity ? 0 : 583231, login: "octocat" });
        }
        if (url.startsWith("https://api.github.com/user/emails")) {
          return Response.json([
            { email: "octocat@example.com", primary: true, verified: true, visibility: null },
          ]);
        }
        throw new Error(`Unexpected external request: ${url}`);
      });
      try {
        const env = {
          WEB_APP_URL: PUBLIC_WEB_ORIGIN,
          BROWSER_AUTH_SECRET: SECRET,
          GITHUB_CLIENT_ID: "github-client-id",
          GITHUB_CLIENT_SECRET: "github-client-secret",
          ALLOWED_USERS: "octocat",
        } as Env;
        const { auth } = createUserAuthRuntimeFromEnv(env, database);
        const initiation = await auth.handler(
          new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
            method: "POST",
            headers: { Origin: PUBLIC_WEB_ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "github", callbackURL: "/", disableRedirect: true }),
          })
        );
        expect(initiation.status).toBe(200);
        const initiationPayload = (await initiation.json()) as { url: string };
        const state = new URL(initiationPayload.url).searchParams.get("state");
        const cookie = initiation.headers.get("Set-Cookie")!.split(";", 1)[0];
        const callback = await auth.handler(
          new Request(
            `${PUBLIC_WEB_ORIGIN}/api/auth/callback/github?code=code&state=${encodeURIComponent(state ?? "")}`,
            { headers: { Cookie: cookie } }
          )
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("Set-Cookie")).toContain("__Secure-openinspect.session_token=");
        const user = await database.prepare("SELECT id FROM users").first<{ id: string }>();
        const account = await database
          .prepare("SELECT id FROM user_identities WHERE provider = 'github'")
          .first<{ id: string }>();
        expect(user).not.toBeNull();
        expect(account).not.toBeNull();
        malformedIdentity = failure === "integrity";
        // Reuse the exact auth instance after its callback for integrity errors;
        // admission removal creates a runtime with the updated allowlist.
        const accountAuth =
          failure === "admission"
            ? createUserAuthRuntimeFromEnv({ ...env, ALLOWED_USERS: "someone-else" }, database).auth
            : auth;
        const lookup = resolveGitHubAccountProfile(accountAuth.api, {
          accountId: account!.id,
          userId: user!.id,
        });
        await expect(lookup).rejects.toBeInstanceOf(
          failure === "admission" ? AdmissionDeniedError : OAuthProviderError
        );
        if (failure === "integrity")
          await expect(lookup).rejects.toMatchObject({ failure: "malformed_response" });
      } finally {
        fetchMock.mockRestore();
        database.close();
      }
    }
  );
});
