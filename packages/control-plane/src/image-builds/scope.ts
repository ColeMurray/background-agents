/**
 * Scope resolution — the ONLY module in the image-build subsystem that
 * switches on scope kind. Everything downstream (planner, workflow, store,
 * routes, adapters) is scope-agnostic and treats the kind as data.
 *
 * Resolution is split into phases rather than one monolithic call because the
 * planner's register-before-secrets ordering depends on it: the repository
 * set is resolved BEFORE the build row is registered (cheap, secret-free),
 * while secrets and sandbox settings are loaded AFTER, so a concurrent secret
 * change always sees a row to supersede.
 *
 * Only the environment arm is implemented; the repo arm lands with the
 * repo-scope slice and throws ImageBuildScopeUnsupportedError until then.
 */

import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { EnvironmentStore } from "../db/environments";
import { GlobalSecretsStore } from "../db/global-secrets";
import {
  auditSecretsMerge,
  mergeSecretSources,
  parseSecretsCapMode,
} from "../db/secrets-validation";
import { createLogger } from "../logger";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { Env } from "../types";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import { computeRepositoriesFingerprint } from "./fingerprint";
import type { ImageBuildScope } from "./model";
import type { ImageBuildRepository } from "./types";

const logger = createLogger("image-builds:scope");

/** A scope kind no arm of the resolver implements (repo, until its slice lands). */
export class ImageBuildScopeUnsupportedError extends Error {
  constructor(kind: string) {
    super(`Image build scope kind is not supported yet: ${kind}`);
    this.name = "ImageBuildScopeUnsupportedError";
  }
}

/** Repositories + fingerprint, resolved before a build row exists. */
export interface ResolvedImageBuildTarget {
  repositories: ImageBuildRepository[];
  repositoriesFingerprint: string;
}

/** An enabled scope with everything the cron's trigger checks need. */
export interface EnabledScopeUnit {
  scope: ImageBuildScope;
  /** Display label of the owning entity; served only by the legacy alias routes. */
  name: string | null;
  repositories: ImageBuildRepository[];
  repositoriesFingerprint: string;
}

/** The scope's buildable repository set, in position order ([0] = primary). */
export async function resolveScopeTarget(
  env: Env,
  scope: ImageBuildScope
): Promise<ResolvedImageBuildTarget> {
  switch (scope.kind) {
    case "environment": {
      const store = new EnvironmentStore(env.DB);
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
        repositories,
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
      };
    }
    case "repo":
      throw new ImageBuildScopeUnsupportedError(scope.kind);
  }
}

/**
 * Prebuild enablement from the owning entity. False when the entity is gone —
 * spawn selection must never serve a deleted scope's lingering row — or when
 * its prebuild flag is off: a disabled scope's frozen image never rebuilds,
 * so serving it would drift unboundedly.
 */
export async function resolveScopeEnabled(
  db: D1Database,
  scope: ImageBuildScope
): Promise<boolean> {
  switch (scope.kind) {
    case "environment": {
      const environment = await new EnvironmentStore(db).getById(scope.id);
      return environment?.prebuild_enabled === 1;
    }
    case "repo":
      throw new ImageBuildScopeUnsupportedError(scope.kind);
  }
}

/** Every prebuild-enabled scope, cheap form (ids only) for status aggregation. */
export async function listEnabledScopes(db: D1Database): Promise<ImageBuildScope[]> {
  const { environments } = await new EnvironmentStore(db).list();
  return environments
    .filter((row) => row.prebuild_enabled === 1)
    .map((row) => ({ kind: "environment" as const, id: row.id }));
}

/**
 * Every prebuild-enabled scope with its current repositories and fingerprint —
 * everything the rebuild cron's trigger checks need, so the fingerprint
 * algorithm never leaves the control plane.
 */
export async function listEnabledScopeUnits(db: D1Database): Promise<EnabledScopeUnit[]> {
  const store = new EnvironmentStore(db);
  const { environments } = await store.list();
  const enabled = environments.filter((row) => row.prebuild_enabled === 1);
  const repositoriesById = await store.getRepositoriesForEnvironmentIds(
    enabled.map((row) => row.id)
  );

  return Promise.all(
    enabled.map(async (row) => {
      const repositories = (repositoriesById.get(row.id) ?? []).map((repo) => ({
        repoOwner: repo.repo_owner,
        repoName: repo.repo_name,
        baseBranch: repo.base_branch,
      }));
      return {
        scope: { kind: "environment" as const, id: row.id },
        name: row.name,
        repositories,
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
      };
    })
  );
}

/**
 * Sandbox settings governing the build (timeout): the primary repository's
 * settings with the environment's own overrides layered on top for
 * environment scopes.
 */
export async function resolveScopeSandboxSettings(
  db: D1Database,
  scope: ImageBuildScope,
  primary: ImageBuildRepository
): Promise<Awaited<ReturnType<typeof resolveSandboxSettings>>> {
  switch (scope.kind) {
    case "environment":
      return resolveSandboxSettings(db, primary.repoOwner, primary.repoName, scope.id);
    case "repo":
      throw new ImageBuildScopeUnsupportedError(scope.kind);
  }
}

/**
 * Build-time secrets: the same fold the scope's sessions get. For environment
 * scopes that is global + environment — repo-scoped secrets never inherit
 * (build/session parity). Source labels match the session fold
 * (session-target-secrets.ts) so collision/cap logs attribute identically at
 * build and session time.
 */
export async function loadScopeBuildSecrets(
  env: Env,
  scope: ImageBuildScope
): Promise<Record<string, string> | undefined> {
  if (scope.kind === "repo") {
    throw new ImageBuildScopeUnsupportedError(scope.kind);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) return undefined;

  let globalSecrets: Record<string, string> = {};
  try {
    const globalStore = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    globalSecrets = await globalStore.getDecryptedSecrets();
  } catch (e) {
    logger.warn("image_build.global_secrets_failed", {
      error: errorMessage(e),
      scope_kind: scope.kind,
      scope_id: scope.id,
    });
  }

  let environmentSecrets: Record<string, string> = {};
  try {
    const environmentStore = new EnvironmentSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    environmentSecrets = await environmentStore.getDecryptedSecrets(scope.id);
  } catch (e) {
    logger.warn("image_build.environment_secrets_failed", {
      error: errorMessage(e),
      scope_kind: scope.kind,
      scope_id: scope.id,
    });
  }

  const merge = mergeSecretSources([
    { label: "global", secrets: globalSecrets },
    { label: "environment", secrets: environmentSecrets },
  ]);
  auditSecretsMerge({
    merge,
    mode: parseSecretsCapMode(env.SECRETS_CAP_ENFORCEMENT),
    log: logger,
    context: { scope_kind: scope.kind, scope_id: scope.id },
  });

  if (Object.keys(merge.merged).length === 0) return undefined;

  logger.info("image_build.secrets_loaded", {
    global_count: Object.keys(globalSecrets).length,
    environment_count: Object.keys(environmentSecrets).length,
    merged_count: Object.keys(merge.merged).length,
    payload_bytes: merge.totalBytes,
    exceeds_limit: merge.exceedsLimit,
    scope_kind: scope.kind,
    scope_id: scope.id,
  });

  return merge.merged;
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
