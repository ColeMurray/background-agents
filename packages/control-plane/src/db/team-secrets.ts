import { z } from "zod";
import {
  assertScopeKeyCapacity,
  decryptSecretRows,
  encryptSecretEntries,
  prepareSecretsForWrite,
  toSecretMetadata,
  type SecretsWriteResult,
} from "./scoped-secrets";
import { normalizeKey, validateKey, type SecretMetadata } from "./secrets-validation";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { TeamAuditStore, type TeamAuditInput } from "./team-audit";

const keyRowSchema = z.object({ key: z.string().min(1) });
const metadataRowSchema = keyRowSchema.extend({
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
const encryptedRowSchema = keyRowSchema.extend({ encrypted_value: z.string().min(1) });
type SecretAuditInput = Pick<TeamAuditInput, "requestId" | "actorUserId">;

export class TeamSecretsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(
    teamId: string,
    secrets: Record<string, unknown>,
    audit?: SecretAuditInput
  ): Promise<SecretsWriteResult> {
    const normalized = prepareSecretsForWrite(secrets);
    const existing = await this.db
      .prepare("SELECT key FROM team_secrets WHERE team_id = ?")
      .bind(teamId)
      .all();
    const existingKeys = new Set(existing.results.map((row) => keyRowSchema.parse(row).key));
    const keys = Object.keys(normalized);
    assertScopeKeyCapacity("Team", existingKeys, keys);
    const { entries, created, updated } = await encryptSecretEntries(
      normalized,
      existingKeys,
      this.encryptionKey
    );
    const now = Date.now();
    const statements = entries.map((entry) =>
      this.db
        .prepare(
          `INSERT INTO team_secrets (team_id, key, encrypted_value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(team_id, key) DO UPDATE SET
             encrypted_value = excluded.encrypted_value,
             updated_at = excluded.updated_at`
        )
        .bind(teamId, entry.key, entry.encryptedValue, now, now)
    );
    if (statements.length > 0) {
      if (audit) {
        statements.push(
          new TeamAuditStore(this.db).bind({
            ...audit,
            teamId,
            action: "team.secret_set",
            before: { keys: keys.filter((key) => existingKeys.has(key)) },
            after: { keys },
          })
        );
      }
      statements.push(this.bindSupersedeEnvironmentImages(teamId));
      await this.db.batch(statements);
    }
    return { created, updated, keys };
  }

  async listSecretKeys(teamId: string): Promise<SecretMetadata[]> {
    const rows = await this.db
      .prepare(
        "SELECT key, created_at, updated_at FROM team_secrets WHERE team_id = ? ORDER BY key"
      )
      .bind(teamId)
      .all();
    return toSecretMetadata(rows.results.map((row) => metadataRowSchema.parse(row)));
  }

  async getDecryptedSecrets(teamId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .prepare("SELECT key, encrypted_value FROM team_secrets WHERE team_id = ?")
      .bind(teamId)
      .all();
    return decryptSecretRows(
      rows.results.map((row) => encryptedRowSchema.parse(row)),
      this.encryptionKey
    );
  }

  async deleteSecret(teamId: string, key: string, audit?: SecretAuditInput): Promise<boolean> {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);
    const statements = [
      this.db
        .prepare("DELETE FROM team_secrets WHERE team_id = ? AND key = ?")
        .bind(teamId, normalizedKey),
    ];
    if (audit) {
      statements.push(
        new TeamAuditStore(this.db).bind(
          {
            ...audit,
            teamId,
            action: "team.secret_deleted",
            before: { keys: [normalizedKey] },
            after: { keys: [] },
          },
          true
        )
      );
    }
    statements.push(this.bindSupersedeEnvironmentImages(teamId));
    const [deleted] = await this.db.batch(statements);
    return deleted.meta.changes > 0;
  }

  private bindSupersedeEnvironmentImages(teamId: string): SqlStatement {
    // Keep this after the mutation and its audit: either changes one row, but a missing delete does not.
    return this.db
      .prepare(
        `UPDATE image_builds SET status = 'superseded'
         WHERE scope_kind = 'environment'
           AND scope_id IN (SELECT id FROM environments WHERE owner_team_id = ?)
           AND status IN ('building', 'ready')
           AND changes() = 1`
      )
      .bind(teamId);
  }
}
