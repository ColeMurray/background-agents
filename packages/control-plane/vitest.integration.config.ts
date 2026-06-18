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

// vitest 4 / @cloudflare/vitest-pool-workers v0.16 replaced the
// `defineWorkersConfig` + `test.poolOptions.workers` setup with the
// `cloudflareTest()` Vite plugin, configured via `defineConfig` from
// "vitest/config". The old `singleWorker`/`isolatedStorage` poolOptions are not
// configured here; integration tests share one D1 instance and rely on explicit
// `cleanD1Tables()` cleanup (see test/integration/cleanup.ts) for isolation.
// That cleanup-based isolation only holds when files run one at a time — see
// `fileParallelism: false` below.
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
    // Run integration files serially. They share a single D1 instance, so
    // running them in parallel lets one file's beforeEach `cleanD1Tables()`
    // DELETE rows another file just seeded. The scheduler tick scans automations
    // globally (getOverdueAutomations + an unconditional DELETE in cleanup), so
    // concurrent files made its tick tests flaky (an overdue automation could
    // vanish mid-tick). Serial execution is what makes cleanup-based isolation
    // actually hold.
    fileParallelism: false,
  },
});
