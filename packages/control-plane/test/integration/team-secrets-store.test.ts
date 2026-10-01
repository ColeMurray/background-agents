import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../../src/auth/crypto";
import {
  MAX_SECRETS_PER_SCOPE,
  MAX_TOTAL_VALUE_SIZE,
  MAX_VALUE_SIZE,
  SecretsValidationError,
} from "../../src/db/secrets-validation";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { TeamSecretsStore } from "../../src/db/team-secrets";
import { TeamStore } from "../../src/db/teams";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

const AUDIT = { requestId: "team-secret-request", actorUserId: "team-secret-actor" };

async function secretAudits() {
  return (
    await env.DB.prepare(
      "SELECT action, resource_type, resource_id, team_id, actor_user_id_snapshot, request_id, operation_result, metadata_json FROM authorization_audit_events WHERE action IN ('team.secret_set', 'team.secret_deleted') ORDER BY occurred_at, id"
    ).all()
  ).results;
}

function failingAuditDatabase(): SqlDatabase {
  const db = sqlDatabase(env.DB);
  return {
    prepare(sql) {
      return db.prepare(
        sql.includes("INSERT INTO authorization_audit_events")
          ? sql.replace("'applied'", "'invalid-result'")
          : sql
      );
    },
    batch<T>(statements: SqlStatement[]) {
      return db.batch<T>(statements);
    },
  };
}

describe("TeamSecretsStore", () => {
  let teamId: string;
  let store: TeamSecretsStore;

  beforeEach(async () => {
    await cleanD1Tables();
    teamId = (
      await new TeamStore(env.DB).create({
        slug: "secret-team",
        name: "Secrets",
        joinPolicy: "invite_only",
      })
    ).id;
    store = new TeamSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  });

  it("normalizes keys, encrypts with the shared key, lists metadata, upserts and deletes", async () => {
    expect(
      await store.setSecrets(teamId, { token: "secret-value", API_URL: "https://example.test" })
    ).toEqual({ created: 2, updated: 0, keys: ["TOKEN", "API_URL"] });
    const stored = await env.DB.prepare(
      "SELECT encrypted_value FROM team_secrets WHERE team_id = ? AND key = 'TOKEN'"
    )
      .bind(teamId)
      .first<{ encrypted_value: string }>();
    expect(stored?.encrypted_value).not.toContain("secret-value");
    expect(await decryptToken(stored!.encrypted_value, env.REPO_SECRETS_ENCRYPTION_KEY!)).toBe(
      "secret-value"
    );
    expect(await store.listSecretKeys(teamId)).toEqual([
      { key: "API_URL", createdAt: expect.any(Number), updatedAt: expect.any(Number) },
      { key: "TOKEN", createdAt: expect.any(Number), updatedAt: expect.any(Number) },
    ]);
    await env.DB.prepare("UPDATE team_secrets SET created_at = 1, updated_at = 1 WHERE team_id = ?")
      .bind(teamId)
      .run();
    expect(await store.setSecrets(teamId, { TOKEN: "replacement" })).toEqual({
      created: 0,
      updated: 1,
      keys: ["TOKEN"],
    });
    expect(await store.listSecretKeys(teamId)).toContainEqual({
      key: "TOKEN",
      createdAt: 1,
      updatedAt: expect.any(Number),
    });
    expect(await store.getDecryptedSecrets(teamId)).toEqual({
      API_URL: "https://example.test",
      TOKEN: "replacement",
    });
    expect(await store.deleteSecret(teamId, "token")).toBe(true);
    expect(await store.deleteSecret(teamId, "TOKEN")).toBe(false);
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ API_URL: "https://example.test" });
  });

  it("isolates identical keys between teams", async () => {
    const other = await new TeamStore(env.DB).create({
      slug: "other-team",
      name: "Other",
      joinPolicy: "invite_only",
    });
    await store.setSecrets(teamId, { TOKEN: "first" });
    await store.setSecrets(other.id, { TOKEN: "second" });
    await store.deleteSecret(teamId, "TOKEN");
    expect(await store.listSecretKeys(teamId)).toEqual([]);
    expect(await store.getDecryptedSecrets(other.id)).toEqual({ TOKEN: "second" });
  });

  it.each([
    { "BAD-KEY": "value" },
    { PATH: "value" },
    { "": "value" },
    { ["K".repeat(257)]: "value" },
    { token: "one", TOKEN: "two" },
    { TOKEN: 123 },
    { TOKEN: "x".repeat(MAX_VALUE_SIZE + 1) },
    Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`KEY_${i}`, "x".repeat(MAX_TOTAL_VALUE_SIZE / 4)])
    ),
  ])("rejects invalid entries without writing secrets or audits (%#)", async (secrets) => {
    await expect(store.setSecrets(teamId, secrets, AUDIT)).rejects.toBeInstanceOf(
      SecretsValidationError
    );
    expect(await store.listSecretKeys(teamId)).toEqual([]);
    expect(await secretAudits()).toEqual([]);
  });

  it("enforces the existing-key union cap while allowing updates at capacity", async () => {
    const secrets = Object.fromEntries(
      Array.from({ length: MAX_SECRETS_PER_SCOPE }, (_, i) => [`KEY_${i}`, "value"])
    );
    await store.setSecrets(teamId, secrets);
    expect(await store.setSecrets(teamId, { KEY_0: "updated" })).toMatchObject({ updated: 1 });
    await expect(store.setSecrets(teamId, { EXTRA: "value" }, AUDIT)).rejects.toThrow(
      `Team would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit`
    );
    expect(await store.listSecretKeys(teamId)).toHaveLength(MAX_SECRETS_PER_SCOPE);
    expect(await secretAudits()).toEqual([]);
  });

  it("records only affected key names with the mutation and skips empty writes and missing deletes", async () => {
    await store.setSecrets(teamId, { token: "sensitive-plaintext" }, AUDIT);
    await store.setSecrets(teamId, { TOKEN: "sensitive-replacement", NEW_KEY: "new-value" }, AUDIT);
    await store.deleteSecret(teamId, "token", AUDIT);
    const audits = await secretAudits();
    expect(audits).toHaveLength(3);
    for (const row of audits) {
      expect(row).toMatchObject({
        resource_type: "team",
        resource_id: teamId,
        team_id: teamId,
        actor_user_id_snapshot: AUDIT.actorUserId,
        request_id: AUDIT.requestId,
        operation_result: "applied",
      });
    }
    const setEvents = audits.filter((row) => row.action === "team.secret_set");
    expect(setEvents.map((row) => JSON.parse(String(row.metadata_json)))).toEqual(
      expect.arrayContaining([
        { before: { keys: [] }, requested: {}, after: { keys: ["TOKEN"] } },
        { before: { keys: ["TOKEN"] }, requested: {}, after: { keys: ["TOKEN", "NEW_KEY"] } },
      ])
    );
    expect(
      JSON.parse(String(audits.find((row) => row.action === "team.secret_deleted")?.metadata_json))
    ).toEqual({ before: { keys: ["TOKEN"] }, requested: {}, after: { keys: [] } });
    const ciphertext = await env.DB.prepare(
      "SELECT encrypted_value FROM team_secrets WHERE team_id = ?"
    )
      .bind(teamId)
      .first<{ encrypted_value: string }>();
    for (const value of [
      "sensitive-plaintext",
      "sensitive-replacement",
      "new-value",
      ciphertext!.encrypted_value,
    ]) {
      expect(JSON.stringify(audits)).not.toContain(value);
    }
    expect(await store.setSecrets(teamId, {}, AUDIT)).toEqual({ created: 0, updated: 0, keys: [] });
    expect(await store.deleteSecret(teamId, "MISSING", AUDIT)).toBe(false);
    expect(await secretAudits()).toHaveLength(3);
  });

  it("rolls back every upsert and deletion when the operation audit fails", async () => {
    await store.setSecrets(teamId, { TOKEN: "original" });
    const failing = new TeamSecretsStore(failingAuditDatabase(), env.REPO_SECRETS_ENCRYPTION_KEY!);
    await expect(
      failing.setSecrets(teamId, { TOKEN: "changed", NEW_KEY: "new" }, AUDIT)
    ).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    await expect(failing.deleteSecret(teamId, "TOKEN", AUDIT)).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    expect(await secretAudits()).toEqual([]);
  });

  it("does not record an applied audit for a failed foreign-key mutation", async () => {
    await expect(store.setSecrets("team_missing", { TOKEN: "secret" }, AUDIT)).rejects.toThrow();
    expect(await secretAudits()).toEqual([]);
  });

  it.each(["bad-key", "PATH", ""])(
    "validates delete key %j before mutating or auditing",
    async (key) => {
      await expect(store.deleteSecret(teamId, key, AUDIT)).rejects.toBeInstanceOf(
        SecretsValidationError
      );
      expect(await secretAudits()).toEqual([]);
    }
  );

  it("validates database metadata, encrypted rows, and existing keys with Zod", async () => {
    await store.setSecrets(teamId, { TOKEN: "value" });
    await env.DB.prepare("UPDATE team_secrets SET updated_at = 'invalid' WHERE team_id = ?")
      .bind(teamId)
      .run();
    await expect(store.listSecretKeys(teamId)).rejects.toMatchObject({ name: "ZodError" });
    await env.DB.prepare("UPDATE team_secrets SET encrypted_value = '' WHERE team_id = ?")
      .bind(teamId)
      .run();
    await expect(store.getDecryptedSecrets(teamId)).rejects.toMatchObject({ name: "ZodError" });
    await env.DB.prepare("UPDATE team_secrets SET key = '' WHERE team_id = ?").bind(teamId).run();
    await expect(store.setSecrets(teamId, { OTHER: "value" })).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("fails closed on corrupt ciphertext without including it in the error", async () => {
    await store.setSecrets(teamId, { TOKEN: "value" });
    await env.DB.prepare(
      "UPDATE team_secrets SET encrypted_value = 'corrupt-sensitive-ciphertext' WHERE team_id = ?"
    )
      .bind(teamId)
      .run();
    await expect(store.getDecryptedSecrets(teamId)).rejects.toThrow(
      "Failed to decrypt secret 'TOKEN'"
    );
  });
});
