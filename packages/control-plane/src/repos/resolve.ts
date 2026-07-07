import type { CreateSessionRequest, RepositoryRef } from "@open-inspect/shared";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import { createRouteSourceControlProvider, HttpError, type RequestContext } from "../routes/shared";

/**
 * One requested member of a session's repository list, exactly as normalized
 * by sessionRepositoriesInputSchema (derived, so it cannot drift from it).
 */
export type SessionRepositoryResolutionInput = NonNullable<
  CreateSessionRequest["repositories"]
>[number];

interface ResolutionOutcome {
  input: SessionRepositoryResolutionInput;
  ref: RepositoryRef | null;
  reason: string | null;
  /** True when the SCM provider threw (vs. cleanly reporting no access). */
  errored: boolean;
}

/**
 * Resolve a session's repository list against the SCM provider concurrently.
 *
 * All-or-nothing, unlike resolveAutomationRepositories: a session boots one
 * sandbox for the whole set, so a single unresolvable member fails the create.
 * Raises an HttpError naming every failing repository — 400 when the provider
 * cleanly reported no access (bad request content), 500 when any lookup threw.
 */
export async function resolveSessionRepositories(
  env: Env,
  inputs: SessionRepositoryResolutionInput[],
  ctx: RequestContext,
  logger: Logger,
  sourceControlProvider?: SourceControlProvider
): Promise<RepositoryRef[]> {
  const provider = sourceControlProvider ?? createRouteSourceControlProvider(env);

  const outcomes = await Promise.all(
    inputs.map(async (input): Promise<ResolutionOutcome> => {
      try {
        const access = await provider.checkRepositoryAccess({
          owner: input.repoOwner,
          name: input.repoName,
        });
        if (!access) {
          return {
            input,
            ref: null,
            reason: "not installed for the GitHub App",
            errored: false,
          };
        }
        return {
          input,
          ref: {
            repoOwner: access.repoOwner,
            repoName: access.repoName,
            repoId: access.repoId,
            baseBranch: input.baseBranch?.trim() || access.defaultBranch || "main",
          },
          reason: null,
          errored: false,
        };
      } catch (e) {
        logger.error("Failed to resolve session repository", {
          error: e instanceof Error ? e.message : String(e),
          repo_owner: input.repoOwner,
          repo_name: input.repoName,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        return { input, ref: null, reason: "resolution failed", errored: true };
      }
    })
  );

  const failures = outcomes.filter((outcome) => outcome.ref === null);
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.input.repoOwner}/${failure.input.repoName} (${failure.reason})`)
      .join(", ");
    throw new HttpError(
      `Failed to resolve repositories: ${detail}`,
      failures.some((failure) => failure.errored) ? 500 : 400
    );
  }

  const refs = outcomes.map((outcome) => outcome.ref as RepositoryRef);

  // Providers may canonicalize identities (GitLab follows project redirects
  // after renames), so the input schema's uniqueness invariants must be
  // re-checked on the RESOLVED identities: distinct repositories (D1 keys
  // member rows by owner/name) and distinct repo names (checkout paths are
  // /workspace/{repoName}).
  const seenFullNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const ref of refs) {
    const fullName = `${ref.repoOwner}/${ref.repoName}`;
    if (seenFullNames.has(fullName)) {
      throw new HttpError(`repositories resolve to the same repository: ${fullName}`, 400);
    }
    if (seenNames.has(ref.repoName)) {
      throw new HttpError(`repositories resolve to the same checkout path: ${ref.repoName}`, 400);
    }
    seenFullNames.add(fullName);
    seenNames.add(ref.repoName);
  }

  return refs;
}
