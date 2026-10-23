import { resolveJsonPath, type WebhookRepositoryFromPayload } from "@open-inspect/shared/triggers";
import {
  normalizeOptionalRepositoryPair,
  validateRepositoryPathSegments,
  type RepositoryRef,
} from "@open-inspect/shared/types/repositories";
import { SourceControlProviderError, type SourceControlProvider } from "../source-control";

/** A delivery error the webhook sender can act on; no new session was launched. */
export class WebhookRepositoryResolutionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 503 = 400,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WebhookRepositoryResolutionError";
  }
}

/** Unicode mode matches unpaired UTF-16 surrogates while accepting valid pairs. */
function isValidBranch(branch: string): boolean {
  return (
    Boolean(branch) &&
    branch.length <= 255 &&
    !branch.startsWith("-") &&
    !/[\uD800-\uDFFF]/u.test(branch) &&
    !/[~^:?*[\\]/.test(branch) &&
    ![...branch].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    ) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    !branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}

/** Resolve one target, checking installation access and a real branch before admission. */
export async function resolveWebhookRepository(
  config: WebhookRepositoryFromPayload,
  body: unknown,
  provider: SourceControlProvider
): Promise<RepositoryRef> {
  const owner = resolveJsonPath(config.repoOwnerPath, body);
  const name = resolveJsonPath(config.repoNamePath, body);
  if (typeof owner !== "string" || !owner.trim() || typeof name !== "string" || !name.trim()) {
    throw new WebhookRepositoryResolutionError(
      "Payload must contain non-empty repoOwner and repoName strings at the configured paths"
    );
  }
  const pair = normalizeOptionalRepositoryPair({ repoOwner: owner, repoName: name })!;
  if (
    !validateRepositoryPathSegments(pair.repoOwner, pair.repoName) ||
    [pair.repoName, ...pair.repoOwner.split("/")].some(
      (segment) => !/^[a-z0-9_.-]+$/i.test(segment) || segment === "." || segment === ".."
    )
  ) {
    throw new WebhookRepositoryResolutionError("Payload repository identity is invalid");
  }
  const allowed = (repoOwner: string, repoName: string) =>
    !config.allowedRepositories ||
    config.allowedRepositories.some(
      (repo) =>
        repo.repoOwner === repoOwner.toLowerCase() && repo.repoName === repoName.toLowerCase()
    );
  if (!allowed(pair.repoOwner, pair.repoName)) {
    throw new WebhookRepositoryResolutionError(
      "Payload repository is not in the automation allowlist",
      403
    );
  }
  const rawBranch = config.branchPath ? resolveJsonPath(config.branchPath, body) : undefined;
  if (
    rawBranch !== undefined &&
    rawBranch !== null &&
    (typeof rawBranch !== "string" || !rawBranch.trim())
  ) {
    throw new WebhookRepositoryResolutionError(
      "Payload branch must be a non-empty string when provided"
    );
  }
  const branchOverride = typeof rawBranch === "string" ? rawBranch.trim() : config.fallbackBranch;
  if (branchOverride !== undefined && !isValidBranch(branchOverride)) {
    throw new WebhookRepositoryResolutionError("Resolved branch is invalid");
  }
  try {
    const access = await provider.checkRepositoryAccess({
      owner: pair.repoOwner,
      name: pair.repoName,
    });
    if (!access || !allowed(access.repoOwner, access.repoName)) {
      throw new WebhookRepositoryResolutionError(
        "Payload repository is not accessible to the configured SCM installation or allowlist",
        403
      );
    }
    const branch = branchOverride ?? access.defaultBranch;
    // getBranchHead accepts a branch, rather than tags or arbitrary commit-ish values.
    if (!isValidBranch(branch)) {
      throw new WebhookRepositoryResolutionError("Resolved branch is invalid");
    }
    const head = await provider.getBranchHead(
      { owner: access.repoOwner, name: access.repoName, branch },
      { kind: "repositories", repositoryIds: [access.repoId] }
    );
    if (!head)
      throw new WebhookRepositoryResolutionError(`Resolved branch does not exist: ${branch}`);
    return {
      repoOwner: access.repoOwner,
      repoName: access.repoName,
      repoId: access.repoId,
      baseBranch: branch,
    };
  } catch (error) {
    if (error instanceof WebhookRepositoryResolutionError) throw error;
    if (error instanceof SourceControlProviderError && error.errorType === "permanent") {
      const forbidden =
        error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 404;
      throw new WebhookRepositoryResolutionError(
        forbidden
          ? "Repository or branch access was denied by the SCM provider"
          : "Repository or branch lookup was rejected by the SCM provider",
        forbidden ? 403 : 400,
        { cause: error }
      );
    }
    throw new WebhookRepositoryResolutionError(
      "Repository or branch lookup failed; retry the webhook delivery",
      503,
      { cause: error }
    );
  }
}
