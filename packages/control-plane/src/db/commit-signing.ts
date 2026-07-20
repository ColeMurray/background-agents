import type { CommitSigningMetadata } from "@open-inspect/shared";

import { decryptToken, encryptToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export interface CommitSigningConfigurationInput {
  privateKey: string;
  committerName: string;
  committerEmail: string;
  publicKey: string;
  fingerprint: string;
}

export type SandboxCommitSigningConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      committerName: string;
      committerEmail: string;
      publicKey: string;
    };

export type DecryptedCommitSigningConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      publicKey: string;
      fingerprint: string;
      privateKey: string;
    };

interface MetadataRow {
  committer_name: string;
  committer_email: string;
  public_key: string;
  fingerprint: string;
  updated_at: number;
}

interface ConfigurationRow {
  encrypted_private_key: string;
  public_key: string;
  fingerprint: string;
}

interface RuntimeConfigurationRow {
  committer_name: string;
  committer_email: string;
  public_key: string;
}

export class CommitSigningStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async save(input: CommitSigningConfigurationInput): Promise<CommitSigningMetadata> {
    const encryptedPrivateKey = await encryptToken(input.privateKey, this.encryptionKey);
    const now = Date.now();

    await this.db
      .prepare(
        `INSERT INTO commit_signing_configuration (
           singleton_id, encrypted_private_key, committer_name, committer_email,
           public_key, fingerprint, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           encrypted_private_key = excluded.encrypted_private_key,
           committer_name = excluded.committer_name,
           committer_email = excluded.committer_email,
           public_key = excluded.public_key,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at`
      )
      .bind(
        encryptedPrivateKey,
        input.committerName,
        input.committerEmail,
        input.publicKey,
        input.fingerprint,
        now
      )
      .run();

    return this.toMetadata({
      committer_name: input.committerName,
      committer_email: input.committerEmail,
      public_key: input.publicKey,
      fingerprint: input.fingerprint,
      updated_at: now,
    });
  }

  async getMetadata(): Promise<CommitSigningMetadata> {
    const row = await this.db
      .prepare(
        `SELECT committer_name, committer_email, public_key, fingerprint, updated_at
         FROM commit_signing_configuration WHERE singleton_id = 1`
      )
      .first<MetadataRow>();

    return row ? this.toMetadata(row) : { enabled: false };
  }

  async getRuntimeConfiguration(): Promise<SandboxCommitSigningConfiguration> {
    const row = await this.db
      .prepare(
        `SELECT committer_name, committer_email, public_key
         FROM commit_signing_configuration WHERE singleton_id = 1`
      )
      .first<RuntimeConfigurationRow>();

    if (!row) return { enabled: false };
    return {
      enabled: true,
      committerName: row.committer_name,
      committerEmail: row.committer_email,
      publicKey: row.public_key,
    };
  }

  async getDecryptedSigningConfiguration(): Promise<DecryptedCommitSigningConfiguration> {
    const row = await this.db
      .prepare(
        `SELECT encrypted_private_key, public_key, fingerprint
         FROM commit_signing_configuration WHERE singleton_id = 1`
      )
      .first<ConfigurationRow>();

    if (!row) return { enabled: false };

    const privateKey = await decryptToken(row.encrypted_private_key, this.encryptionKey);
    return {
      enabled: true,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      privateKey,
    };
  }

  async delete(): Promise<void> {
    await this.db.prepare("DELETE FROM commit_signing_configuration WHERE singleton_id = 1").run();
  }

  private toMetadata(row: MetadataRow): CommitSigningMetadata {
    return {
      enabled: true,
      committerName: row.committer_name,
      committerEmail: row.committer_email,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
