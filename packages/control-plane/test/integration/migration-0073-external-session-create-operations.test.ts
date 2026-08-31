import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";

const USER_ID = "33333333333333333333333333333333";

describe("migration 0073: external session create operations", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(USER_ID);
  });
  afterEach(cleanD1Tables);

  it("enforces result presence and legal immutable transitions", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO external_session_create_operations
         (user_id, idempotency_key, request_hash, session_id, stage, result_json, created_at, updated_at)
         VALUES (?, 'invalid', 'hash', 'session-invalid', 'completed', NULL, 1, 1)`
      )
        .bind(USER_ID)
        .run()
    ).rejects.toThrow();

    await env.DB.prepare(
      `INSERT INTO external_session_create_operations
       (user_id, idempotency_key, request_hash, session_id, stage, created_at, updated_at)
       VALUES (?, 'valid', 'hash', 'session-valid', 'reserved', 1, 1)`
    )
      .bind(USER_ID)
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE external_session_create_operations SET stage = 'completed', result_json = '{}' WHERE idempotency_key = 'valid'"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE external_session_create_operations SET stage = 'session_created' WHERE idempotency_key = 'valid'"
    ).run();
    await env.DB.prepare(
      "UPDATE external_session_create_operations SET stage = 'completed', result_json = '{}' WHERE idempotency_key = 'valid'"
    ).run();
    await expect(
      env.DB.prepare(
        "UPDATE external_session_create_operations SET result_json = '{\"changed\":true}' WHERE idempotency_key = 'valid'"
      ).run()
    ).rejects.toThrow();
  });
});
