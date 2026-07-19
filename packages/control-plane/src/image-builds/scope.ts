/**
 * Scope resolution — the ONLY module in the image-build subsystem that
 * switches on scope kind. Everything downstream (planner, workflow, store,
 * routes, adapters) is scope-agnostic and treats the kind as data.
 *
 * Resolution is split into phases rather than one monolithic call because the
 * planner's register-before-secrets ordering depends on it: the repository
 * set is resolved BEFORE the build row is registered (secret-free), while
 * secrets and sandbox settings are loaded AFTER, so a concurrent secret
 * change always sees a row to supersede.
 */

import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { EnvironmentStore } from "../db/environments";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoMetadataStore } from "../db/repo-metadata";
import { RepoSecretsStore } from "../db/repo-secrets";
import {
  auditSecretsMerge,
  mergeSecretSources,
  parseSecretsCapMode,
  type SecretSource,
} from "../db/secrets-validation";
import { createLogger } from "../logger";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import {
  createSourceControlProviderFromEnv,
  SourceControlProviderError,
  type RepositoryAccessResult,
} from "../source-control";
import type { Env } from "../types";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import { computeRepositoriesFingerprint } from "./fingerprint";
import { parseRepoScopeId, repoImageBuildScope, type ImageBuildScope } from "./model";
import type { ImageBuildRepository } from "./types";
import type { SqlDatabase } from "../db/sql-database";

const logger = createLogger("image-builds:scope");

interface ResolvedImageBuildTargetBase {
  repositories: ImageBuildRepository[];
  repositoriesFingerprint: string;
}

/**
 * Repositories + fingerprint, resolved before a build row exists.
 * Discriminated on the scope kind that produced it, so per-kind extras (a
 * repo scope's repoId) exist exactly on the arm that has them.
 */
export type ResolvedImageBuildTarget =
  | (ResolvedImageBuildTargetBase & { kind: "environment" })
  | (ResolvedImageBuildTargetBase & {
      kind: "repo";
      /**
       * Source-control numeric id of the repo scope's repository — the
       * repo_secrets key, resolved together with the target so the secrets
       * fold (loadScopeBuildSecrets) needs no second source-control round
       * trip.
       */
      repoId: number;
    });

/** An enabled scope with everything the cron's trigger checks need. */
export interface EnabledScopeUnit {
  scope: ImageBuildScope;
  repositories: ImageBuildRepository[];
  repositoriesFingerprint: string;
}

/** The scope's buildable repository set, in position order ([0] = primary). */
export async function resolveScopeTarget(
  env: Env,
  db: SqlDatabase,
  scope: ImageBuildScope
): Promise<ResolvedImageBuildTarget> {
  switch (scope.kind) {
    case "environment": {
      const store = new EnvironmentStore(db);
      const environment = await store.getById(scope.id);
      if (!environment) {
        throw new ImageBuildScopeNotFoundError(scope.kind, scope.id);
      }

      const repositoryRows = await store.getRepositoriesForEnvironment(scope.id);
      if (repositoryRows.length === 0) {
        // Unreachable through the schema (environments require >= 1 repository);
        // defensive against direct store writes.
        throw new ImageBuildPlanningError(`Environment has no repositories: ${scope.id}`);
      }

      const repositories: ImageBuildRepository[] = repositoryRows.map((row) => ({
        repoOwner: row.repo_owner,
        repoName: row.repo_name,
        baseBranch: row.base_branch,
      }));

      return {
        kind: "environment",
        repositories,
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
      };
    }
    case "repo": {
      const repo = parseRepoScopeId(scope.id);
      if (!repo) {
        throw new ImageBuildPlanningError(`Malformed repo scope id: ${scope.id}`);
      }

      const resolved = await resolveRepositoryAccess(env, scope, repo);
      if (!resolved) {
        throw new ImageBuildScopeNotFoundError(scope.kind, scope.id);
      }

      // A repo scope always builds the repository's default branch; a session
      // on any other branch computes a different fingerprint and falls back
      // to the base image, reproducing the old base_branch spawn filter.
      const repositories: ImageBuildRepository[] = [
        {
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          baseBranch: resolved.defaultBranch,
        },
      ];

      return {
        kind: "repo",
        repositories,
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
        repoId: resolved.repoId,
      };
    }
  }
}

async function resolveRepositoryAccess(
  env: Env,
  scope: ImageBuildScope,
  repo: { repoOwner: string; repoName: string }
): Promise<RepositoryAccessResult | null> {
  try {
    const provider = createSourceControlProviderFromEnv(env);
    return await provider.checkRepositoryAccess({ owner: repo.repoOwner, name: repo.repoName });
  } catch (e) {
    const message = errorMessage(e);
    logger.error("image_build.scope_resolve_failed", {
      error: message,
      scope_kind: scope.kind,
      scope_id: scope.id,
    });
    // Permanent non-HTTP provider errors are configuration problems whose
    // message is safe and actionable; anything else stays generic.
    const isConfigError =
      e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus;
    throw new ImageBuildPlanningError(isConfigError ? message : "Failed to resolve repository", e);
  }
}

/**
 * Prebuild enablement from the owning entity. False when the entity is gone —
 * spawn selection must never serve a deleted scope's lingering row — or when
 * its prebuild flag is off: a disabled scope's frozen image never rebuilds,
 * so serving it would drift unboundedly.
 */
export async function resolveScopeEnabled(
  db: SqlDatabase,
  scope: ImageBuildScope
): Promise<boolean> {
  switch (scope.kind) {
    case "environment": {
      const environment = await new EnvironmentStore(db).getById(scope.id);
      return environment?.prebuild_enabled === 1;
    }
    case "repo": {
      const repo = parseRepoScopeId(scope.id);
      if (!repo) return false;
      return new RepoMetadataStore(db).getImageBuildEnabled(repo.repoOwner, repo.repoName);
    }
  }
}

/** Every prebuild-enabled scope, cheap form (ids only) for status aggregation. */
export async function listEnabledScopes(db: SqlDatabase): Promise<ImageBuildScope[]> {
  const { environments } = await new EnvironmentStore(db).list();
  const environmentScopes = environments
    .filter((row) => row.prebuild_enabled === 1)
    .map((row) => ({ kind: "environment" as const, id: row.id }));

  const repos = await new RepoMetadataStore(db).getImageBuildEnabledRepos();
  const repoScopes = repos.map((repo) => repoImageBuildScope(repo.repoOwner, repo.repoName));

  return [...environmentScopes, ...repoScopes];
}

/**
 * Every prebuild-enabled scope with its current repositories and fingerprint —
 * everything the rebuild cron's trigger checks need, so the fingerprint
 * algorithm never leaves the control plane. A repo scope whose repository
 * cannot be resolved (uninstalled, source-control outage) is skipped with a
 * warning rather than failing the whole feed.
 */
export async function listEnabledScopeUnits(
  env: Env,
  db: SqlDatabase
): Promise<EnabledScopeUnit[]> {
  const store = new EnvironmentStore(db);
  const { environments } = await store.list();
  const enabled = environments.filter((row) => row.prebuild_enabled === 1);
  const repositoriesById = await store.getRepositoriesForEnvironmentIds(
    enabled.map((row) => row.id)
  );

  const environmentUnits = await Promise.all(
    enabled.map(async (row) => {
      const repositories = (repositoriesById.get(row.id) ?? []).map((repo) => ({
        repoOwner: repo.repo_owner,
        repoName: repo.repo_name,
        baseBranch: repo.base_branch,
      }));
      return {
        scope: { kind: "environment" as const, id: row.id },
        repositories,
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
      };
    })
  );

  const enabledRepos = await new RepoMetadataStore(db).getImageBuildEnabledRepos();
  const repoUnits = await Promise.all(
    enabledRepos.map(async (repo): Promise<EnabledScopeUnit | null> => {
      const scope = repoImageBuildScope(repo.repoOwner, repo.repoName);
      try {
        const target = await resolveScopeTarget(env, db, scope);
        return {
          scope,
          repositories: target.repositories,
          repositoriesFingerprint: target.repositoriesFingerprint,
        };
      } catch (e) {
        logger.warn("image_build.enabled_unit_skipped", {
          error: errorMessage(e),
          scope_kind: scope.kind,
          scope_id: scope.id,
        });
        return null;
      }
    })
  );

  return [...environmentUnits, ...repoUnits.filter((unit) => unit !== null)];
}

/**
 * Sandbox settings governing the build (timeout): the primary repository's
 * settings, with the environment's own overrides layered on top for
 * environment scopes (a repo scope has no environment layer by definition).
 */
export async function resolveScopeSandboxSettings(
  db: SqlDatabase,
  scope: ImageBuildScope,
  primary: ImageBuildRepository
): Promise<Awaited<ReturnType<typeof resolveSandboxSettings>>> {
  switch (scope.kind) {
    case "environment":
      return resolveSandboxSettings(db, primary.repoOwner, primary.repoName, scope.id);
    case "repo":
      return resolveSandboxSettings(db, primary.repoOwner, primary.repoName);
  }
}

/**
 * Build-time secrets: the same fold the scope's sessions get. Environment
 * scopes fold global + environment — repo-scoped secrets never inherit —
 * and repo scopes fold global + that repository's secrets (build/session
 * parity in both cases). Source labels match the session fold
 * (session-target-secrets.ts) so collision/cap logs attribute identically at
 * build and session time.
 */
export async function loadScopeBuildSecrets(
  env: Env,
  db: SqlDatabase,
  scope: ImageBuildScope,
  target: ResolvedImageBuildTarget
): Promise<Record<string, string> | undefined> {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) return undefined;

  const { sources, counts } = await loadScopeSecretSources(
    db,
    scope,
    target,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );

  const merge = mergeSecretSources(sources);
  auditSecretsMerge({
    merge,
    mode: parseSecretsCapMode(env.SECRETS_CAP_ENFORCEMENT),
    log: logger,
    context: { scope_kind: scope.kind, scope_id: scope.id },
  });

  if (Object.keys(merge.merged).length === 0) return undefined;

  logger.info("image_build.secrets_loaded", {
    ...counts,
    merged_count: Object.keys(merge.merged).length,
    payload_bytes: merge.totalBytes,
    exceeds_limit: merge.exceedsLimit,
    scope_kind: scope.kind,
    scope_id: scope.id,
  });

  return merge.merged;
}

async function loadScopeSecretSources(
  db: SqlDatabase,
  scope: ImageBuildScope,
  target: ResolvedImageBuildTarget,
  encryptionKey: string
): Promise<{ sources: SecretSource[]; counts: Record<string, number> }> {
  let globalSecrets: Record<string, string> = {};
  try {
    globalSecrets = await new GlobalSecretsStore(db, encryptionKey).getDecryptedSecrets();
  } catch (e) {
    logger.warn("image_build.global_secrets_failed", {
      error: errorMessage(e),
      scope_kind: scope.kind,
      scope_id: scope.id,
    });
  }

  switch (target.kind) {
    case "environment": {
      let environmentSecrets: Record<string, string> = {};
      try {
        environmentSecrets = await new EnvironmentSecretsStore(
          db,
          encryptionKey
        ).getDecryptedSecrets(scope.id);
      } catch (e) {
        logger.warn("image_build.environment_secrets_failed", {
          error: errorMessage(e),
          scope_kind: scope.kind,
          scope_id: scope.id,
        });
      }
      return {
        sources: [
          { label: "global", secrets: globalSecrets },
          { label: "environment", secrets: environmentSecrets },
        ],
        counts: {
          global_count: Object.keys(globalSecrets).length,
          environment_count: Object.keys(environmentSecrets).length,
        },
      };
    }
    case "repo": {
      let repoSecrets: Record<string, string> = {};
      try {
        repoSecrets = await new RepoSecretsStore(db, encryptionKey).getDecryptedSecrets(
          target.repoId
        );
      } catch (e) {
        logger.warn("image_build.repo_secrets_failed", {
          error: errorMessage(e),
          scope_kind: scope.kind,
          scope_id: scope.id,
        });
      }
      return {
        sources: [
          { label: "global", secrets: globalSecrets },
          { label: scope.id, secrets: repoSecrets },
        ],
        counts: {
          global_count: Object.keys(globalSecrets).length,
          repo_count: Object.keys(repoSecrets).length,
        },
      };
    }
  }
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
