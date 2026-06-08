import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { webcrypto } from "node:crypto";

const migrationsPath = path.resolve(__dirname, "../../terraform/d1/migrations");

/** Generate a random base64-encoded 32-byte AES key for tests. */
function generateTestEncryptionKey(): string {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(key).toString("base64");
}

// vitest 4 / @cloudflare/vitest-pool-workers v0.16 moved the pool from
// `test.poolOptions.workers` to the `cloudflareTest()` Vite plugin, configured
// via the standard `defineConfig` from "vitest/config". The old `singleWorker`
// and `isolatedStorage` options were removed: the pool now implements isolated
// per-test storage natively (the SQLite -shm/-wal cleanup bug that forced
// `isolatedStorage: false` — workers-sdk#5667 / #11031 — is fixed upstream).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            INTERNAL_CALLBACK_SECRET: "test-hmac-secret-for-integration-tests",
            TOKEN_ENCRYPTION_KEY: "test-encryption-key-32chars-long!",
            REPO_SECRETS_ENCRYPTION_KEY: generateTestEncryptionKey(),
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
  },
});
