import { generateBranchName, type SessionArtifact } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { resolveHeadBranchForPr, sanitizeBranchName } from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
} from "../source-control";
import type { SessionRepositoryRow } from "./repository";
import type { ArtifactRow, SessionRow } from "./types";

/**
 * Inputs required to create a PR once caller identity/auth are already resolved.
 */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
  /**
   * Target member repository, already validated against the session's
   * repository list by the HTTP handler (canonical casing).
   */
  repoOwner: string;
  repoName: string;
  promptingUserId: string;
  promptingAuth: SourceControlAuthContext | null;
  sessionUrl: string;
}

export type CreatePullRequestResult =
  | {
      kind: "created";
      prNumber: number;
      prUrl: string;
      state: "open" | "closed" | "merged" | "draft";
    }
  | { kind: "error"; status: number; error: string };

export type PushBranchResult = { success: true } | { success: false; error: string };

function repoIdentityEquals(
  a: { repoOwner: string; repoName: string },
  b: { repoOwner: string; repoName: string }
): boolean {
  return (
    a.repoOwner.toLowerCase() === b.repoOwner.toLowerCase() &&
    a.repoName.toLowerCase() === b.repoName.toLowerCase()
  );
}

/**
 * Repo identity from a PR artifact's metadata. Null when the metadata carries
 * no identity — artifacts written before multi-repo support, which by
 * construction belong to the session's primary repository.
 */
function parseArtifactRepo(
  metadata: string | null
): { repoOwner: string; repoName: string } | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { repoOwner, repoName } = parsed as { repoOwner?: unknown; repoName?: unknown };
    if (typeof repoOwner !== "string" || typeof repoName !== "string") return null;
    return { repoOwner, repoName };
  } catch {
    return null;
  }
}

/**
 * Session persistence operations required by pull request orchestration.
 */
export interface PullRequestRepository {
  getSession(): SessionRow | null;
  getSessionRepositories(): SessionRepositoryRow[];
  updateSessionBranch(sessionId: string, branchName: string): void;
  updateSessionRepositoryBranch(repoOwner: string, repoName: string, branchName: string): void;
  listArtifacts(): ArtifactRow[];
  createArtifact(data: {
    id: string;
    type: "pr" | "branch";
    url: string | null;
    metadata: string | null;
    createdAt: number;
  }): void;
}

/**
 * Durable-object adapters that bridge runtime concerns into the service.
 */
export interface PullRequestServiceDeps {
  repository: PullRequestRepository;
  sourceControlProvider: SourceControlProvider;
  log: Logger;
  generateId: () => string;
  pushBranchToRemote: (pushSpec: GitPushSpec) => Promise<PushBranchResult>;
  broadcastSessionBranch: (
    branchName: string,
    repo: { repoOwner: string; repoName: string }
  ) => void;
  broadcastArtifactCreated: (artifact: SessionArtifact) => void;
  /** Display name used in the PR body footer (e.g. "Created with [name](url)"). */
  appName: string;
}

/**
 * Orchestrates branch push and PR creation for a session.
 * Participant lookup and token resolution are handled by SessionDO.
 */
export class SessionPullRequestService {
  constructor(private readonly deps: PullRequestServiceDeps) {}

  /**
   * Creates a pull request when OAuth auth is available, or falls back
   * to a manual PR URL artifact when user OAuth cannot be used.
   */
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const session = this.deps.repository.getSession();
    if (!session) {
      return { kind: "error", status: 404, error: "Session not found" };
    }
    if (!session.repo_owner || !session.repo_name) {
      return { kind: "error", status: 400, error: "Pull requests require a repository context" };
    }

    const memberRow =
      this.deps.repository
        .getSessionRepositories()
        .find((row) =>
          repoIdentityEquals({ repoOwner: row.repo_owner, repoName: row.repo_name }, input)
        ) ?? null;
    const isPrimary = repoIdentityEquals(
      { repoOwner: session.repo_owner, repoName: session.repo_name },
      input
    );
    // Sessions predating the member table have no rows; the target must then
    // be the scalar repository. Re-checked here (the handler already 403s)
    // because this is a sandbox-auth security boundary.
    if (!memberRow && !isPrimary) {
      return {
        kind: "error",
        status: 403,
        error: `Repository ${input.repoOwner}/${input.repoName} is not part of this session`,
      };
    }
    const targetRepo = {
      repoOwner: memberRow?.repo_owner ?? session.repo_owner,
      repoName: memberRow?.repo_name ?? session.repo_name,
    };

    this.deps.log.info("Creating PR", {
      user_id: input.promptingUserId,
      repo_owner: targetRepo.repoOwner,
      repo_name: targetRepo.repoName,
    });

    try {
      const sessionId = session.session_name || session.id;
      const generatedHeadBranch = generateBranchName(sessionId);

      const initialArtifacts = this.deps.repository.listArtifacts();
      if (this.findPrArtifactForRepo(initialArtifacts, targetRepo, isPrimary)) {
        return this.duplicatePrError(targetRepo);
      }

      let pushAuth: GitPushAuthContext;
      try {
        pushAuth = await this.deps.sourceControlProvider.generatePushAuth();
        this.deps.log.info("Generated fresh push auth token");
      } catch (error) {
        this.deps.log.error("Failed to generate push auth", {
          error: error instanceof Error ? error : String(error),
        });
        return {
          kind: "error",
          status: 500,
          error:
            error instanceof SourceControlProviderError
              ? error.message
              : "Failed to generate push authentication",
        };
      }

      const appAuth: SourceControlAuthContext = {
        authType: "app",
        token: pushAuth.token,
      };

      const repoInfo = await this.deps.sourceControlProvider.getRepository(appAuth, {
        owner: targetRepo.repoOwner,
        name: targetRepo.repoName,
      });
      // Base: requested > target repo's base branch (scalar mirror for
      // sessions without member rows) > repo default. Behavioral parity with
      // the session-base injection the HTTP handler used to do.
      const baseBranch =
        input.baseBranch || memberRow?.base_branch || session.base_branch || repoInfo.defaultBranch;
      // The target repo's working branch; member rows written before PR flow
      // existed have a null branch_name while the scalar mirror is set, so
      // the primary falls back to the scalar.
      const targetBranchName = memberRow?.branch_name ?? (isPrimary ? session.branch_name : null);
      const branchResolution = resolveHeadBranchForPr({
        requestedHeadBranch: input.headBranch,
        sessionBranchName: targetBranchName,
        generatedBranchName: generatedHeadBranch,
        baseBranch,
      });
      const headBranch = branchResolution.headBranch;
      this.deps.log.info("Resolved PR head branch", {
        requested_head_branch: input.headBranch ?? null,
        session_branch_name: targetBranchName,
        generated_head_branch: generatedHeadBranch,
        resolved_head_branch: headBranch,
        resolution_source: branchResolution.source,
        base_branch: baseBranch,
      });
      const sanitizedHeadBranch = sanitizeBranchName(headBranch);
      if (!sanitizedHeadBranch) {
        return {
          kind: "error",
          status: 400,
          error: "headBranch must be a valid branch name",
        };
      }

      const pushSpec = this.deps.sourceControlProvider.buildGitPushSpec({
        owner: targetRepo.repoOwner,
        name: targetRepo.repoName,
        sourceRef: "HEAD",
        targetBranch: sanitizedHeadBranch,
        auth: pushAuth,
        force: true,
      });

      const pushResult = await this.deps.pushBranchToRemote(pushSpec);
      if (!pushResult.success) {
        return { kind: "error", status: 500, error: pushResult.error };
      }

      if (memberRow && memberRow.branch_name !== sanitizedHeadBranch) {
        this.deps.repository.updateSessionRepositoryBranch(
          memberRow.repo_owner,
          memberRow.repo_name,
          sanitizedHeadBranch
        );
      }
      if (isPrimary && session.branch_name !== sanitizedHeadBranch) {
        this.deps.repository.updateSessionBranch(session.id, sanitizedHeadBranch);
      }
      // Broadcast even when the stored branch is already current so connected clients converge
      // after missed or out-of-order updates.
      this.deps.broadcastSessionBranch(sanitizedHeadBranch, targetRepo);

      const latestArtifacts = this.deps.repository.listArtifacts();
      if (this.findPrArtifactForRepo(latestArtifacts, targetRepo, isPrimary)) {
        return this.duplicatePrError(targetRepo);
      }

      // Use user OAuth if available, otherwise fall back to GitHub App token
      // (e.g. sessions triggered from Linear or other integrations without user GitHub OAuth)
      const prAuth = input.promptingAuth ?? appAuth;

      const fullBody =
        input.body + `\n\n---\n*Created with [${this.deps.appName}](${input.sessionUrl})*`;

      const prResult = await this.deps.sourceControlProvider.createPullRequest(prAuth, {
        repository: repoInfo,
        title: input.title,
        body: fullBody,
        sourceBranch: sanitizedHeadBranch,
        targetBranch: baseBranch,
      });

      const artifactId = this.deps.generateId();
      const now = Date.now();
      const artifactMetadata = {
        number: prResult.id,
        state: prResult.state,
        head: sanitizedHeadBranch,
        base: baseBranch,
        repoOwner: targetRepo.repoOwner,
        repoName: targetRepo.repoName,
      };
      this.deps.repository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: JSON.stringify(artifactMetadata),
        createdAt: now,
      });

      this.deps.broadcastArtifactCreated({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: artifactMetadata,
        createdAt: now,
      });

      return {
        kind: "created",
        prNumber: prResult.id,
        prUrl: prResult.webUrl,
        state: prResult.state,
      };
    } catch (error) {
      this.deps.log.error("PR creation failed", {
        error: error instanceof Error ? error : String(error),
      });

      if (error instanceof SourceControlProviderError) {
        return {
          kind: "error",
          status: error.httpStatus || 500,
          error: error.message,
        };
      }

      return {
        kind: "error",
        status: 500,
        error: error instanceof Error ? error.message : "Failed to create PR",
      };
    }
  }

  /**
   * One PR per repo per session: find an existing PR artifact for the target
   * repo. Artifact metadata without repo identity predates multi-repo
   * sessions and belongs to the primary.
   */
  private findPrArtifactForRepo(
    artifacts: ArtifactRow[],
    targetRepo: { repoOwner: string; repoName: string },
    isPrimary: boolean
  ): ArtifactRow | undefined {
    return artifacts.find((artifact) => {
      if (artifact.type !== "pr") return false;
      const artifactRepo = parseArtifactRepo(artifact.metadata);
      if (!artifactRepo) return isPrimary;
      return repoIdentityEquals(artifactRepo, targetRepo);
    });
  }

  private duplicatePrError(targetRepo: {
    repoOwner: string;
    repoName: string;
  }): CreatePullRequestResult {
    return {
      kind: "error",
      status: 409,
      error: `A pull request has already been created for ${targetRepo.repoOwner}/${targetRepo.repoName} in this session.`,
    };
  }
}
