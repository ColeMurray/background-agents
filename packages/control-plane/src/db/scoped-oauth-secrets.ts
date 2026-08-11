import { EnvironmentSecretsStore } from "./environment-secrets";
import { GlobalSecretsStore } from "./global-secrets";
import { RepoSecretsStore } from "./repo-secrets";
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
}
