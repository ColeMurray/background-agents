import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GuardedWriteConflictError,
  runGuardedBatch,
  type GuardedWrite,
} from "../../src/db/guarded-write";
import { cleanD1Tables } from "./cleanup";

const userId = "11111111111111111111111111111111";

function userInsert() {
  return env.DB.prepare(
    `INSERT INTO users
      (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
     VALUES (?, 'Guarded User', NULL, 0, NULL, 1, 1)`
  ).bind(userId);
}

describe("guarded writes", () => {
  beforeEach(cleanD1Tables);

  it("commits mutations when the assertion predicate holds", async () => {
    const guard: GuardedWrite = { name: "allowed", predicate: { sql: "1", values: [] } };

    await expect(runGuardedBatch(env.DB, [guard], [userInsert()])).resolves.toHaveLength(1);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first()).toEqual({
      id: userId,
    });
  });

  it("rolls the batch back when the assertion constraint rejects a predicate", async () => {
    const guard: GuardedWrite = { name: "denied", predicate: { sql: "0", values: [] } };

    await expect(runGuardedBatch(env.DB, [guard], [userInsert()])).rejects.toBeInstanceOf(
      GuardedWriteConflictError
    );
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first()
    ).toBeNull();
  });
});
