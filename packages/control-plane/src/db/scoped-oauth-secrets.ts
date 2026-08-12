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
   * Rotation write guarded by the ciphertext `guard.key` was read at: the guard
   * row is swapped only if it is unchanged, then the remaining secrets are
   * upserted. Returns false — writing nothing — when the guard row changed
   * underneath us, i.e. a concurrent rotation persisted first. The guard row is
   * written before the rest so a failure between the two writes can never leave
   * an older guard value over a newer one; the worst case is a stale companion
   * row (a cached access token), which ages out on its own.
   */
  async casWrite(
    scope: OAuthSecretScope,
    guard: { key: string; expectedCiphertext: string },
    secrets: Record<string, string>
  ): Promise<boolean> {
    const { [guard.key]: guardValue, ...companions } = secrets;
    if (guardValue === undefined) {
      throw new Error(`casWrite requires secrets to include guard key '${guard.key}'`);
    }

    const swapped = await this.casUpdateSecret(
      scope,
      guard.key,
      guard.expectedCiphertext,
      guardValue
    );
    if (!swapped) return false;

    if (Object.keys(companions).length > 0) {
      await this.write(scope, companions);
    }
    return true;
  }

  private casUpdateSecret(
    scope: OAuthSecretScope,
    key: string,
    expectedCiphertext: string,
    value: string
  ): Promise<boolean> {
    switch (scope.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).casUpdateSecret(
          scope.environmentId,
          key,
          expectedCiphertext,
          value
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).casUpdateSecret(
          scope.repoId,
          key,
          expectedCiphertext,
          value
        );
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).casUpdateSecret(
          key,
          expectedCiphertext,
          value
        );
    }
  }
}
