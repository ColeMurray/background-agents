import type { CommitSigningMetadata } from "@open-inspect/shared";

import { decryptToken, encryptToken } from "../auth/crypto";

export interface CommitSigningConfigurationInput {
  privateKey: string;
  keyFormat: "ssh-ed25519";
  githubLogin: string;
  committerName: string;
  committerEmail: string;
  publicKey: string;
  fingerprint: string;
  validatedAt: number;
}

export type SandboxCommitSigningConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      keyFormat: "ssh-ed25519";
      githubLogin: string;
      committerName: string;
      committerEmail: string;
      publicKey: string;
      fingerprint: string;
      privateKey: string;
    };

interface MetadataRow {
  key_format: "ssh-ed25519";
  github_login: string;
  committer_name: string;
  committer_email: string;
  public_key: string;
  fingerprint: string;
  validated_at: number;
  updated_at: number;
}

interface ConfigurationRow {
  encrypted_private_key: string;
  key_format: "ssh-ed25519";
  github_login: string;
  committer_name: string;
  committer_email: string;
  public_key: string;
  fingerprint: string;
}

interface DeletedConfigurationRow {
  fingerprint: string;
}

export class CommitSigningStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async save(input: CommitSigningConfigurationInput): Promise<CommitSigningMetadata> {
    const encryptedPrivateKey = await encryptToken(input.privateKey, this.encryptionKey);
    const now = Date.now();

    await this.db
      .prepare(
        `INSERT INTO commit_signing_configuration (
           singleton_id, encrypted_private_key, key_format, github_login,
           committer_name, committer_email, public_key, fingerprint,
           validated_at, created_at, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           encrypted_private_key = excluded.encrypted_private_key,
           key_format = excluded.key_format,
           github_login = excluded.github_login,
           committer_name = excluded.committer_name,
           committer_email = excluded.committer_email,
           public_key = excluded.public_key,
           fingerprint = excluded.fingerprint,
           validated_at = excluded.validated_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        encryptedPrivateKey,
        input.keyFormat,
        input.githubLogin,
        input.committerName,
        input.committerEmail,
        input.publicKey,
        input.fingerprint,
        input.validatedAt,
        now,
        now
      )
      .run();

    return this.toMetadata({
      key_format: input.keyFormat,
      github_login: input.githubLogin,
      committer_name: input.committerName,
      committer_email: input.committerEmail,
      public_key: input.publicKey,
      fingerprint: input.fingerprint,
      validated_at: input.validatedAt,
      updated_at: now,
    });
  }

  async getMetadata(): Promise<CommitSigningMetadata> {
    const row = await this.db
      .prepare(
        `SELECT key_format, github_login, committer_name, committer_email,
                public_key, fingerprint, validated_at, updated_at
         FROM commit_signing_configuration WHERE singleton_id = 1`
      )
      .first<MetadataRow>();

    return row ? this.toMetadata(row) : { enabled: false };
  }

  async getDecryptedConfiguration(): Promise<SandboxCommitSigningConfiguration> {
    const row = await this.db
      .prepare(
        `SELECT encrypted_private_key, key_format, github_login, committer_name,
                committer_email, public_key, fingerprint
         FROM commit_signing_configuration WHERE singleton_id = 1`
      )
      .first<ConfigurationRow>();

    if (!row) return { enabled: false };

    const privateKey = await decryptToken(row.encrypted_private_key, this.encryptionKey);
    return {
      enabled: true,
      keyFormat: row.key_format,
      githubLogin: row.github_login,
      committerName: row.committer_name,
      committerEmail: row.committer_email,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      privateKey,
    };
  }

  async delete(): Promise<string | undefined> {
    const deleted = await this.db
      .prepare(
        "DELETE FROM commit_signing_configuration WHERE singleton_id = 1 RETURNING fingerprint"
      )
      .first<DeletedConfigurationRow>();
    return deleted?.fingerprint;
  }

  private toMetadata(row: MetadataRow): CommitSigningMetadata {
    return {
      enabled: true,
      keyFormat: row.key_format,
      githubLogin: row.github_login,
      committerName: row.committer_name,
      committerEmail: row.committer_email,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      validationStatus: "valid",
      validatedAt: new Date(row.validated_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
