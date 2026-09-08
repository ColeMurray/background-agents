import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const migrationsPath = path.resolve(__dirname, "../../terraform/d1/migrations");

// Pin luxon to its CommonJS build. vite 8 resolves luxon via the "import"
// condition to its ESM build, but cron-parser (a CJS transitive dep of
// @open-inspect/shared, used by the scheduler's nextCronOccurrence) reads it as
// `require("luxon").DateTime`. Under @cloudflare/vitest-pool-workers that
// CJS->ESM interop yields `undefined`, so the scheduler tick throws "Cannot read
// properties of undefined (reading 'DateTime')" and silently skips every overdue
// automation (see Scheduler.tick tests). vite 7 used the CJS build,
// which interops correctly. Test-only — production bundles via esbuild/wrangler.
const luxonCjsEntry = createRequire(__filename).resolve("luxon");

/** Generate a random base64-encoded 32-byte AES key for tests. */
function generateTestEncryptionKey(): string {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(key).toString("base64");
}

// vitest 4 / @cloudflare/vitest-pool-workers v0.16 replaced the
// `defineWorkersConfig` + `test.poolOptions.workers` setup with the
// `cloudflareTest()` Vite plugin, configured via `defineConfig` from
// "vitest/config". The old `singleWorker`/`isolatedStorage` poolOptions are not
// configured here; pool-workers isolates D1 storage per test FILE, so files run
// in parallel without cross-file interference. Within a file, tests share one D1
// instance and rely on explicit `cleanD1Tables()` cleanup (see
// test/integration/cleanup.ts) for isolation.
export default defineConfig({
  resolve: {
    alias: {
      luxon: luxonCjsEntry,
    },
  },
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          // Match the Terraform-managed production runtime. The Vitest pool
          // otherwise defaults its runner to today's compatibility date.
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
          async outboundService(request: Request) {
            const url = new URL(request.url);
            if (url.hostname.endsWith(".modal.run")) {
              return new Response("Modal is unavailable in integration tests", { status: 404 });
            }
            if (url.href === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
              return Response.json({
                device_auth_id: "integration-device",
                user_code: "TEST-CODE",
                interval: 1,
              });
            }
            if (url.href === "https://auth.openai.com/api/accounts/deviceauth/token") {
              return Response.json({
                authorization_code: "integration-authorization",
                code_verifier: "integration-verifier",
              });
            }
            if (url.href === "https://auth.openai.com/oauth/token") {
              const body = await request.text();
              if (
                !body.includes("integration-openai") &&
                !body.includes("integration-authorization")
              ) {
                throw new Error("Unexpected OpenAI integration-test credential");
              }
              return Response.json({
                id_token:
                  "eyJhbGciOiJub25lIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LWludGVncmF0aW9uIn0.",
                access_token: "integration-openai-access-token",
                refresh_token: "integration-openai-rotated-refresh",
                expires_in: 3600,
              });
            }
            if (url.href === "https://auth.x.ai/oauth2/device/code") {
              return Response.json({
                device_code: "integration-xai-device",
                user_code: "XAI-CODE",
                verification_uri: "https://accounts.x.ai/oauth2/device",
                verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=XAI-CODE",
                expires_in: 300,
                interval: 1,
              });
            }
            if (url.href === "https://auth.x.ai/oauth2/userinfo") {
              return Response.json({ sub: "xai-integration" });
            }
            if (url.href === "https://auth.x.ai/oauth2/token") {
              const body = await request.text();
              if (body.includes("integration-xai-device")) {
                return Response.json({
                  id_token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4YWktaW50ZWdyYXRpb24ifQ.",
                  access_token: "integration-xai-access-token",
                  refresh_token: "integration-xai-refresh-token",
                  expires_in: 3600,
                });
              }
              if (body.includes("integration-xai")) {
                return Response.json({
                  access_token: "integration-xai-access-token",
                  refresh_token: "integration-xai-rotated-refresh",
                  expires_in: 3600,
                });
              }
              throw new Error("Unexpected xAI integration-test credential");
            }
            throw new Error(`Unexpected outbound request: ${request.url}`);
          },
          queueProducers: ["IMAGE_BUILD_FINALIZATION_QUEUE"],
          bindings: {
            IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
            SERVICE_AUTH_SECRET_WEB: "test-service-secret-web",
            SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
            SERVICE_AUTH_SECRET_GITHUB_BOT: "test-service-secret-github-bot",
            SERVICE_AUTH_SECRET_LINEAR_BOT: "test-service-secret-linear-bot",
            BROWSER_AUTH_SECRET: "test-browser-auth-secret-with-at-least-32-characters",
            GITHUB_CLIENT_ID: "github-app-client-id",
            GITHUB_CLIENT_SECRET: "github-app-client-secret",
            GOOGLE_CLIENT_ID: "google-client-id",
            GOOGLE_CLIENT_SECRET: "google-client-secret",
            UNSAFE_ALLOW_ALL_USERS: "true",
            // Must be valid base64 for 32 bytes — the exchange route's SCM
            // capture encrypts with it inline (fail-closed) rather than
            // inside a swallowed waitUntil.
            TOKEN_ENCRYPTION_KEY: generateTestEncryptionKey(),
            REPO_SECRETS_ENCRYPTION_KEY: generateTestEncryptionKey(),
            PROVIDER_ACCOUNTS_ENCRYPTION_KEY: generateTestEncryptionKey(),
            DEPLOYMENT_NAME: "integration-test",
            MODAL_API_SECRET: "test-modal-api-secret",
            MODAL_WORKSPACE: "test-workspace",
            SLACK_BOT_TOKEN: "xoxb-test-integration",
            WEB_APP_URL: "https://app.test.local",
            APP_NAME: "Open-Inspect",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/integration/apply-migrations.ts"],
    onUnhandledError(error) {
      // Better Auth implements redirects and invalid-token responses as thrown
      // APIError values. Its handler catches and converts them to HTTP responses,
      // but the Workers pool reports the intermediate rejection as unhandled.
      const betterAuthStack =
        "errorStack" in error && typeof error.errorStack === "string"
          ? error.errorStack
          : error.stack;
      const betterAuthErrorCode =
        "body" in error &&
        typeof error.body === "object" &&
        error.body !== null &&
        "code" in error.body &&
        typeof error.body.code === "string"
          ? error.body.code
          : null;
      if (
        error.name === "APIError" &&
        "statusCode" in error &&
        typeof error.statusCode === "number" &&
        ((error.statusCode >= 300 && error.statusCode < 400) ||
          (error.statusCode === 401 && betterAuthErrorCode === "INVALID_TOKEN")) &&
        betterAuthStack?.includes("/better-auth/dist/api/routes/")
      ) {
        return false;
      }
    },
  },
});
