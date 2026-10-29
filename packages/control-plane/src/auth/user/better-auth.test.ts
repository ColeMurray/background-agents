import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { emptyAdmissionRules } from "@open-inspect/shared/admission-settings";
import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase } from "../../node/sqlite-database";
import {
  GitHubAttributionUnavailableError,
  resolveGitHubAccountProfile,
} from "../../source-control/github-credential-authority";
import type { Env } from "../../types";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { AdmissionPolicyStore } from "../../db/admission-policy-store";
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

  it.each([
    { failure: "admission", clientIp: "192.0.2.101" },
    { failure: "unavailable", clientIp: "192.0.2.102" },
    { failure: "integrity", clientIp: "192.0.2.103" },
  ] as const)(
    "preserves $failure error semantics after a browser callback",
    async ({ failure, clientIp }) => {
      // Better Auth's memory rate limiter is shared across auth instances.
      const browserHeaders = { [BROWSER_AUTH_CLIENT_IP_HEADER]: clientIp };
      const sqlite = new DatabaseSync(":memory:");
      const database = createNodeSqlDatabase(sqlite);
      applyMigrations(
        sqlite,
        fileURLToPath(new NodeURL("../../../../../terraform/d1/migrations", import.meta.url))
      );
      await database
        .prepare("UPDATE workspace_admission_policy SET rules_json = ? WHERE id = 1")
        .bind(JSON.stringify({ ...emptyAdmissionRules(), allowedGitHubUsers: ["octocat"] }))
        .run();
      const policyRead = vi.spyOn(AdmissionPolicyStore.prototype, "get");
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
          ALLOWED_USERS: "recovery-user",
        } as Env;
        const { auth } = createUserAuthRuntimeFromEnv(env, database);
        const initiation = await auth.handler(
          new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
            method: "POST",
            headers: {
              ...browserHeaders,
              Origin: PUBLIC_WEB_ORIGIN,
              "Content-Type": "application/json",
            },
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
            { headers: { ...browserHeaders, Cookie: cookie } }
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
        if (failure === "admission") {
          await database
            .prepare(
              "UPDATE workspace_admission_policy SET rules_json = ?, revision = revision + 1 WHERE id = 1"
            )
            .bind(JSON.stringify(emptyAdmissionRules()))
            .run();
        } else if (failure === "unavailable") {
          await database.prepare("DELETE FROM workspace_admission_policy WHERE id = 1").run();
        }

        const sessionCookie = (callback.headers as Headers & { getSetCookie(): string[] })
          .getSetCookie()
          .find((value) => value.startsWith("__Secure-openinspect.session_token="))!
          .split(";", 1)[0];
        const readsAfterCallback = policyRead.mock.calls.length;
        await expect(
          auth.api.getSession({
            headers: new Headers({ ...browserHeaders, Cookie: sessionCookie }),
            query: { disableRefresh: true },
          })
        ).resolves.toMatchObject({ user: { id: user!.id } });
        expect(policyRead).toHaveBeenCalledTimes(readsAfterCallback);

        // Internal account-info resolution must recheck the newly committed policy,
        // even though the same auth instance still accepts its existing session.
        const lookup = resolveGitHubAccountProfile(auth.api, {
          accountId: account!.id,
          userId: user!.id,
        });
        await expect(lookup).rejects.toBeInstanceOf(
          failure === "admission"
            ? AdmissionDeniedError
            : failure === "unavailable"
              ? GitHubAttributionUnavailableError
              : OAuthProviderError
        );
        if (failure === "unavailable")
          await expect(lookup).rejects.toMatchObject({
            cause: expect.any(AdmissionUnavailableError),
          });
        if (failure === "integrity")
          await expect(lookup).rejects.toMatchObject({ failure: "malformed_response" });

        const persistedBefore = await Promise.all(
          ["users", "user_identities", "auth_sessions"].map((table) =>
            database.prepare(`SELECT * FROM ${table}`).all()
          )
        );
        const retry = await auth.handler(
          new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
            method: "POST",
            headers: {
              ...browserHeaders,
              Origin: PUBLIC_WEB_ORIGIN,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ provider: "github", callbackURL: "/", disableRedirect: true }),
          })
        );
        expect(retry.status).toBe(200);
        const retryPayload = (await retry.json()) as { url: string };
        const retryState = new URL(retryPayload.url).searchParams.get("state");
        const failedCallback = await auth.handler(
          new Request(
            `${PUBLIC_WEB_ORIGIN}/api/auth/callback/github?code=retry&state=${encodeURIComponent(retryState ?? "")}`,
            {
              headers: {
                ...browserHeaders,
                Cookie: retry.headers.get("Set-Cookie")!.split(";", 1)[0],
              },
            }
          )
        );
        const expectedCode =
          failure === "admission"
            ? "admission_denied"
            : failure === "unavailable"
              ? "admission_unavailable"
              : "malformed_response";
        expect(failedCallback.status).toBe(302);
        expect(failedCallback.headers.get("Location")).toContain(expectedCode);
        const persistedAfter = await Promise.all(
          ["users", "user_identities", "auth_sessions"].map((table) =>
            database.prepare(`SELECT * FROM ${table}`).all()
          )
        );
        expect(persistedAfter.map((result) => result.results)).toEqual(
          persistedBefore.map((result) => result.results)
        );
      } finally {
        policyRead.mockRestore();
        fetchMock.mockRestore();
        database.close();
      }
    }
  );
});
