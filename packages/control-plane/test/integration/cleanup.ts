import { env } from "cloudflare:test";

/**
 * Clears all D1 tables. Call in beforeEach to isolate tests when
 * isolatedStorage is disabled (see vitest.integration.config.ts).
 */
export async function cleanD1Tables(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM sessions; DELETE FROM repo_metadata; DELETE FROM repo_secrets; DELETE FROM global_secrets;"
  );
}
