import { EnvironmentSecretsStore } from "./environment-secrets";
import { GlobalSecretsStore } from "./global-secrets";
import { RepoSecretsStore } from "./repo-secrets";
import type { StoredSecretValue } from "./scoped-secrets";
import type { SqlDatabase } from "./sql-database";

export type OAuthSecretScope =
  | { kind: "environment"; environmentId: string }
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

/** Reads and writes provider OAuth credentials in their original secret scope. */
export class ScopedOAuthSecretsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  read(scope: OAuthSecretScope): Promise<Record<string, string>> {
    switch (scope.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(
          scope.environmentId
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(scope.repoId);
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets();
    }
  }

  async write(scope: OAuthSecretScope, secrets: Record<string, string>): Promise<void> {
    switch (scope.kind) {
      case "environment":
        await new EnvironmentSecretsStore(this.db, this.encryptionKey).setSecrets(
          scope.environmentId,
          secrets
        );
        return;
      case "repo":
        await new RepoSecretsStore(this.db, this.encryptionKey).setSecrets(
          scope.repoId,
          scope.repoOwner,
          scope.repoName,
          secrets
        );
        return;
      case "global":
        await new GlobalSecretsStore(this.db, this.encryptionKey).setSecrets(secrets);
    }
  }

  /** Read one secret's decrypted value together with the ciphertext it is stored as. */
  readSecretWithCiphertext(
    scope: OAuthSecretScope,
    key: string
  ): Promise<StoredSecretValue | null> {
    switch (scope.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).getSecretWithCiphertext(
          scope.environmentId,
          key
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).getSecretWithCiphertext(
          scope.repoId,
          key
        );
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).getSecretWithCiphertext(key);
    }
  }

  /**
   * Atomic rotation write guarded by the ciphertext `guard.key` was read at:
   * every statement in the underlying batch is conditioned on the guard row
   * being unchanged, and the guard row itself is swapped last, so the whole
   * bundle commits or nothing does. Returns false — having written nothing —
   * when the guard did not match: a concurrent rotation persisted first, or
   * the guard row was deleted (distinguish by re-reading the guard key).
   */
  casWrite(
    scope: OAuthSecretScope,
    guard: { key: string; expectedCiphertext: string },
    secrets: Record<string, string>
  ): Promise<boolean> {
    switch (scope.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).casWriteSecrets(
          scope.environmentId,
          guard.key,
          guard.expectedCiphertext,
          secrets
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).casWriteSecrets(
          scope.repoId,
          scope.repoOwner,
          scope.repoName,
          guard.key,
          guard.expectedCiphertext,
          secrets
        );
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).casWriteSecrets(
          guard.key,
          guard.expectedCiphertext,
          secrets
        );
    }
  }
}
