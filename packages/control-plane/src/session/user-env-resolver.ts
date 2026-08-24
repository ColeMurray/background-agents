/**
 * Resolves the user-defined environment a session's sandbox receives: decrypts
 * and folds global/repo/environment secrets, derives the managed-provider env
 * from the session's provider auth modes, and answers whether a model's
 * provider has usable authentication in that environment. Legacy session rows
 * that predate `repo_id` resolve it through the injected `resolveRepoId`
 * capability when the repo-scoped secrets lookup needs it.
 */

import { SessionIndexStore } from "../db/session-index";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import {
  auditSecretsMerge,
  mergeSecretSources,
  parseSecretsCapMode,
} from "../db/secrets-validation";
import {
  getProviderAuthenticationError as resolveProviderAuthenticationError,
  prepareManagedProviderEnv,
} from "../sandbox/managed-provider-env";
import type {
  SessionProviderAuthMode,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { resolvePublicSessionId } from "./public-session-id";
import { buildSessionTargetSecretSources } from "./session-target-secrets";
import type { SessionRepositoryEntry } from "./repository-target";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";

/**
 * Dependencies injected into UserEnvResolver.
 */
export interface UserEnvResolverDeps {
  db: SqlDatabase | null;
  sessionCoreRepository: SessionCoreRepository;
  /**
   * Resolves (and persists) the session's primary repo id for legacy rows
   * that predate `repo_id` — see `resolveSessionRepoId`. Injected as a
   * capability so this class carries no SCM-provider dependency.
   */
  resolveRepoId: (session: SessionRow) => Promise<number>;
  /** The owning Durable Object's id; the resolvePublicSessionId fallback. */
  durableObjectId: string;
  repoSecretsEncryptionKey: string | undefined;
  secretsCapEnforcement: string | undefined;
  /** The session-scoped logger; the composition root creates it before this class. */
  log: Logger;
}

interface UserEnvContext {
  sandboxEnv: Record<string, string>;
  providerAuthModes: Record<SubscriptionProviderId, SessionProviderAuthMode>;
}

export class UserEnvResolver {
  private readonly db: SqlDatabase | null;
  private readonly sessionCoreRepository: SessionCoreRepository;
  private readonly resolveRepoId: (session: SessionRow) => Promise<number>;
  private readonly durableObjectId: string;
  private readonly repoSecretsEncryptionKey: string | undefined;
  private readonly secretsCapEnforcement: string | undefined;
  private readonly log: Logger;

  constructor(deps: UserEnvResolverDeps) {
    this.db = deps.db;
    this.sessionCoreRepository = deps.sessionCoreRepository;
    this.resolveRepoId = deps.resolveRepoId;
    this.durableObjectId = deps.durableObjectId;
    this.repoSecretsEncryptionKey = deps.repoSecretsEncryptionKey;
    this.secretsCapEnforcement = deps.secretsCapEnforcement;
    this.log = deps.log;
  }

  /**
   * The user-defined environment for the sandbox, or undefined when the
   * session is missing or the assembled environment is empty.
   */
  async getUserEnvVars(): Promise<Record<string, string> | undefined> {
    const context = await this.loadUserEnvContext();
    if (!context) return undefined;
    return Object.keys(context.sandboxEnv).length === 0 ? undefined : context.sandboxEnv;
  }

  /**
   * A user-facing error message when the model's provider has no usable
   * authentication in the assembled environment, or null when authenticated.
   */
  async getProviderAuthenticationError(model: string): Promise<string | null> {
    const context = await this.loadUserEnvContext();
    if (!context) return null;
    const issue = resolveProviderAuthenticationError(
      model,
      context.sandboxEnv,
      context.providerAuthModes
    );
    if (!issue) return null;
    this.log.error("provider_auth.unavailable", {
      event: "provider_auth.unavailable",
      provider: issue.provider,
      auth_mode: context.providerAuthModes[issue.provider],
    });
    return issue.message;
  }

  private async loadUserEnvContext(): Promise<UserEnvContext | null> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      this.log.warn("Cannot load secrets: no session");
      return null;
    }

    const db = this.db;
    if (!db) throw new Error("D1 is required to load session provider auth");
    const providerAuth = await new SessionIndexStore(db).getCompleteProviderAuth(
      resolvePublicSessionId(session, this.durableObjectId)
    );
    const providerAuthModes = Object.fromEntries(
      providerAuth.map(({ provider, authMode }) => [provider, authMode])
    ) as Record<SubscriptionProviderId, SessionProviderAuthMode>;

    if (!this.repoSecretsEncryptionKey) {
      this.log.debug("Ordinary secrets not configured, skipping secret loading", {
        has_encryption_key: !!this.repoSecretsEncryptionKey,
      });
      const sandboxEnv = prepareManagedProviderEnv({
        exposedSecrets: {},
        brokerSecrets: {},
        providerAuthModes,
      });
      return { sandboxEnv, providerAuthModes };
    }

    // Fail hard on secret loading — sandboxes must not silently lose secrets
    const encryptionKey = this.repoSecretsEncryptionKey;
    const globalStore = new GlobalSecretsStore(db, encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();

    const repoStore = new RepoSecretsStore(db, encryptionKey);
    const environmentSecretsStore = new EnvironmentSecretsStore(db, encryptionKey);
    const members = this.sessionCoreRepository.getSessionRepositories();
    const sources = await buildSessionTargetSecretSources({
      environmentId: session.environment_id,
      globalSecrets,
      members,
      loadMemberSecrets: (member) => this.loadMemberRepoSecrets(session, member, repoStore),
      loadEnvironmentSecrets: (environmentId) =>
        environmentSecretsStore.getDecryptedSecrets(environmentId),
    });

    const merge = mergeSecretSources(sources);
    auditSecretsMerge({
      merge,
      mode: parseSecretsCapMode(this.secretsCapEnforcement),
      log: this.log,
      context: { session_id: session.id },
    });

    const mergedCount = Object.keys(merge.merged).length;
    if (mergedCount > 0) {
      this.log.info("Secrets merged for sandbox", {
        source_count: sources.length,
        merged_count: mergedCount,
        payload_bytes: merge.totalBytes,
        exceeds_limit: merge.exceedsLimit,
      });
    }

    const primary = members.find((member) => member.isPrimary);
    const managedSources = session.environment_id
      ? sources
      : sources.filter(
          (source) =>
            source.label === "global" ||
            (primary && source.label === `${primary.repoOwner}/${primary.repoName}`)
        );
    const managedSecrets = mergeSecretSources(managedSources).merged;
    const sandboxEnv = prepareManagedProviderEnv({
      exposedSecrets: merge.merged,
      brokerSecrets: managedSecrets,
      providerAuthModes,
    });
    return { sandboxEnv, providerAuthModes };
  }

  /**
   * Decrypt one member repo's secrets — the injected leaf loader for
   * buildSessionTargetSecretSources. The member row carries the repo id; a
   * synthesized primary (legacy scalar row) resolves it lazily via the
   * injected resolveRepoId. A member without a resolvable id (a secondary
   * with a null row id) can't be keyed, so it contributes nothing.
   */
  private async loadMemberRepoSecrets(
    session: SessionRow,
    member: SessionRepositoryEntry,
    repoStore: RepoSecretsStore
  ): Promise<Record<string, string>> {
    const repoId =
      member.row?.repo_id ?? (member.isPrimary ? await this.resolveRepoId(session) : null);
    if (repoId === null) {
      return {};
    }
    return repoStore.getDecryptedSecrets(repoId);
  }
}
