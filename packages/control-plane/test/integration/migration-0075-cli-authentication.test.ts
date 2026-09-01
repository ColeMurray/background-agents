import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("migration 0075: CLI authentication", () => {
  it("creates hash-only attempts and revocable user credentials", async () => {
    const attemptColumns = await env.DB.prepare(
      "PRAGMA table_info(cli_device_authorization_attempts)"
    ).all<{ name: string }>();
    const credentialColumns = await env.DB.prepare("PRAGMA table_info(cli_credentials)").all<{
      name: string;
    }>();
    const rateLimitColumns = await env.DB.prepare("PRAGMA table_info(cli_auth_rate_limits)").all<{
      name: string;
    }>();
    const attemptIndexes = await env.DB.prepare(
      "PRAGMA index_list(cli_device_authorization_attempts)"
    ).all<{ name: string }>();
    const credentialIndexes = await env.DB.prepare("PRAGMA index_list(cli_credentials)").all<{
      name: string;
    }>();
    const rateLimitIndexes = await env.DB.prepare("PRAGMA index_list(cli_auth_rate_limits)").all<{
      name: string;
    }>();

    expect(attemptColumns.results.map((column) => column.name)).toEqual([
      "id",
      "device_name",
      "device_secret_hash",
      "user_code_hash",
      "approved_user_id",
      "exchange_claim_id",
      "issued_credential_id",
      "created_at",
      "expires_at",
      "approved_at",
      "exchanged_at",
      "capability_revoked_at",
    ]);
    expect(credentialColumns.results.map((column) => column.name)).toEqual([
      "id",
      "token_hash",
      "user_id",
      "created_at",
      "expires_at",
      "last_seen_at",
      "revoked_at",
    ]);
    expect(attemptColumns.results.map((column) => column.name)).not.toContain("device_secret");
    expect(credentialColumns.results.map((column) => column.name)).not.toContain("token");
    expect(rateLimitColumns.results.map((column) => column.name)).toEqual([
      "rate_key",
      "window_started_at",
      "request_count",
      "expires_at",
    ]);
    expect(attemptIndexes.results.map((index) => index.name)).toContain(
      "idx_cli_device_authorization_expiry"
    );
    expect(credentialIndexes.results.map((index) => index.name)).toEqual(
      expect.arrayContaining(["idx_cli_credentials_expiry", "idx_cli_credentials_revoked"])
    );
    expect(rateLimitIndexes.results.map((index) => index.name)).toContain(
      "idx_cli_auth_rate_limits_expiry"
    );
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
