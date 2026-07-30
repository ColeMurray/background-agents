import { describe, expect, it } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createUserAuth } from "./better-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";
const UNUSED_PROFILE_RESOLVER = async () => null;
const UNUSED_USER_PROJECTION = { project: async () => {} };

describe("Better Auth provider execution", () => {
  it("rejects a provider that is disabled before sign-in executes", async () => {
    const auth = createUserAuth({
      database: memoryAdapter({}) as unknown as D1Database,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      userProjection: UNUSED_USER_PROJECTION,
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
