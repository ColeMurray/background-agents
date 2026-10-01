import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../../src/auth/crypto";
import { ImageBuildStore } from "../../src/db/image-builds";
import {
  MAX_SECRETS_PER_SCOPE,
  MAX_TOTAL_VALUE_SIZE,
  MAX_VALUE_SIZE,
  SecretsValidationError,
} from "../../src/db/secrets-validation";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { TeamSecretsStore } from "../../src/db/team-secrets";
import { TeamStore } from "../../src/db/teams";
import { IMAGE_BUILD_PROVIDER_IDS } from "../../src/image-builds/model";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";
import {
  environmentScope,
  getRow,
  seedEnvironment,
  seedImageRowForScope,
} from "./image-build-helpers";

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

function failingInvalidationDatabase(): SqlDatabase {
  const db = sqlDatabase(env.DB);
  return {
    prepare(sql) {
      return db.prepare(
        sql.includes("UPDATE image_builds")
          ? sql.replace("status = 'superseded'", "status = NULL")
          : sql
      );
    },
    batch<T>(statements: SqlStatement[]) {
      return db.batch<T>(statements);
    },
  };
}

async function seedOwnedEnvironment(teamId: string, prebuildEnabled = false): Promise<string> {
  const id = await seedEnvironment({ prebuildEnabled });
  await env.DB.prepare("UPDATE environments SET owner_team_id = ? WHERE id = ?")
    .bind(teamId, id)
    .run();
  return id;
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

  it.each(["set", "delete"] as const)(
    "%s supersedes live images across providers only for the team's environments, even with prebuilds disabled",
    async (mutation) => {
      await store.setSecrets(teamId, { TOKEN: "original" });
      const enabled = await seedOwnedEnvironment(teamId, true);
      const disabled = await seedOwnedEnvironment(teamId);
      const otherTeam = await new TeamStore(env.DB).create({
        slug: "other-image-team",
        name: "Other image team",
        joinPolicy: "invite_only",
      });
      const other = await seedOwnedEnvironment(otherTeam.id);
      const workspace = await seedEnvironment();
      const expected: Record<string, string> = {};
      for (const environmentId of [enabled, disabled]) {
        for (const provider of IMAGE_BUILD_PROVIDER_IDS) {
          for (const status of ["building", "ready"]) {
            const id = `${environmentId}-${provider}-${status}`;
            await seedImageRowForScope(environmentScope(environmentId), {
              id,
              provider,
              status,
              providerImageId: status === "ready" ? `image-${id}` : null,
            });
            expected[id] = "superseded";
          }
        }
      }
      for (const scope of [
        environmentScope(other),
        environmentScope(workspace),
        { kind: "repo" as const, id: enabled },
        { kind: "repo" as const, id: "acme/web" },
      ]) {
        for (const status of ["building", "ready"]) {
          const id = `${scope.kind}-${scope.id}-${status}`;
          await seedImageRowForScope(scope, { id, status });
          expected[id] = status;
        }
      }
      for (const status of ["failed", "superseded"]) {
        await seedImageRowForScope(environmentScope(enabled), { id: status, status });
        expected[status] = status;
      }

      if (mutation === "set") {
        await store.setSecrets(teamId, { TOKEN: "rotated", NEW_KEY: "new" }, AUDIT);
      } else {
        expect(await store.deleteSecret(teamId, "token", AUDIT)).toBe(true);
      }

      const rows = (await env.DB.prepare("SELECT id, status FROM image_builds").all()).results;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual(expected);
      expect(await secretAudits()).toHaveLength(1);
    }
  );

  it.each([true, false])(
    "does not invalidate images for empty writes or missing deletes (audit: %s)",
    async (withAudit) => {
      const environmentId = await seedOwnedEnvironment(teamId);
      await seedImageRowForScope(environmentScope(environmentId), {
        id: "unchanged-image",
        status: "ready",
        providerImageId: "unchanged-artifact",
      });
      const audit = withAudit ? AUDIT : undefined;
      expect(await store.setSecrets(teamId, {}, audit)).toEqual({
        created: 0,
        updated: 0,
        keys: [],
      });
      expect(await store.deleteSecret(teamId, "MISSING", audit)).toBe(false);
      expect((await getRow("unchanged-image"))?.status).toBe("ready");
      expect(await secretAudits()).toEqual([]);
    }
  );

  it.each(["set", "delete"] as const)(
    "invalidates images on a successful unaudited %s",
    async (mutation) => {
      await store.setSecrets(teamId, { TOKEN: "original" });
      const environmentId = await seedOwnedEnvironment(teamId);
      await seedImageRowForScope(environmentScope(environmentId), {
        id: "unaudited-image",
        status: "ready",
      });
      if (mutation === "set") {
        await store.setSecrets(teamId, { TOKEN: "rotated" });
      } else {
        expect(await store.deleteSecret(teamId, "TOKEN")).toBe(true);
      }
      expect((await getRow("unaudited-image"))?.status).toBe("superseded");
      expect(await secretAudits()).toEqual([]);
    }
  );

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
    const environmentId = await seedOwnedEnvironment(teamId);
    await seedImageRowForScope(environmentScope(environmentId), {
      id: "audit-failure-image",
      status: "ready",
    });
    const failing = new TeamSecretsStore(failingAuditDatabase(), env.REPO_SECRETS_ENCRYPTION_KEY!);
    await expect(
      failing.setSecrets(teamId, { TOKEN: "changed", NEW_KEY: "new" }, AUDIT)
    ).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    await expect(failing.deleteSecret(teamId, "TOKEN", AUDIT)).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    expect((await getRow("audit-failure-image"))?.status).toBe("ready");
    expect(await secretAudits()).toEqual([]);
  });

  it("rolls back secrets and key-only audits when image invalidation fails, leaving deletion retryable", async () => {
    await store.setSecrets(teamId, { TOKEN: "original" });
    const environmentId = await seedOwnedEnvironment(teamId);
    const scope = environmentScope(environmentId);
    await seedImageRowForScope(scope, {
      id: "invalidation-failure-image",
      status: "ready",
      providerImageId: "original-artifact",
    });
    const failing = new TeamSecretsStore(
      failingInvalidationDatabase(),
      env.REPO_SECRETS_ENCRYPTION_KEY!
    );
    await expect(
      failing.setSecrets(teamId, { TOKEN: "changed", NEW_KEY: "new" }, AUDIT)
    ).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    expect(await secretAudits()).toEqual([]);
    await expect(failing.deleteSecret(teamId, "TOKEN", AUDIT)).rejects.toThrow();
    expect(await store.getDecryptedSecrets(teamId)).toEqual({ TOKEN: "original" });
    expect((await getRow("invalidation-failure-image"))?.status).toBe("ready");
    expect(await secretAudits()).toEqual([]);

    expect(await store.deleteSecret(teamId, "TOKEN", AUDIT)).toBe(true);
    expect(await new ImageBuildStore(env.DB).getLatestReadyForSpawn(scope, "modal")).toBeNull();
    expect(await secretAudits()).toHaveLength(1);
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
