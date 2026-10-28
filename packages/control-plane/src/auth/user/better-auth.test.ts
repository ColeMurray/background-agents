import { DatabaseSync } from "node:sqlite";
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
        expect(user).not.toBeNull();
        malformedIdentity = failure === "integrity";
        // Reuse the exact auth instance after its callback for integrity errors;
        // admission removal creates a runtime with the updated allowlist.
        const accountAuth =
          failure === "admission"
            ? createUserAuthRuntimeFromEnv({ ...env, ALLOWED_USERS: "someone-else" }, database).auth
            : auth;
        const lookup = resolveGitHubAccountProfile(accountAuth.api, {
          providerId: "github",
          accountId: "583231",
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
