import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "path";

const migrationsPath = path.resolve(__dirname, "../../terraform/d1/migrations");

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
              DEPLOYMENT_NAME: "integration-test",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
