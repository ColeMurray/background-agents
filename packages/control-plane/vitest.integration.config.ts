import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "path";
import { webcrypto } from "node:crypto";

const migrationsPath = path.resolve(__dirname, "../../terraform/d1/migrations");

/** Generate a random base64-encoded 32-byte AES key for tests. */
function generateTestEncryptionKey(): string {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(key).toString("base64");
}

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["test/integration/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // SQLite-backed DOs create .sqlite-shm/.sqlite-wal files that break
          // isolatedStorage's cleanup assertions (asserts all files end in .sqlite).
          // The fix (workers-sdk#5667) never shipped in the pool package — the hard
          // assert is still present in v0.12.10. Symbol.dispose on stubs doesn't
          // help either: the pop runs at suite level after the DO constructor has
          // already created WAL files. See: https://github.com/cloudflare/workers-sdk/issues/11031
          isolatedStorage: false,
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
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
