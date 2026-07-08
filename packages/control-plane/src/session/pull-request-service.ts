import {
  generateBranchName,
  RepositoryPairValidationError,
  type SessionArtifact,
} from "@open-inspect/shared";
import type { Logger } from "../logger";
import { resolveHeadBranchForPr, sanitizeBranchName } from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
} from "../source-control";
import { findPrArtifactForRepo } from "./pr-artifacts";
import {
  AmbiguousRepositoryTargetError,
  RepositoryNotMemberError,
  resolveSessionRepositoryTarget,
  type RepoIdentity,
  type SessionRepositoryEntry,
} from "./repository-target";
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

function claimKey(repo: RepoIdentity): string {
  return `${repo.repoOwner.toLowerCase()}/${repo.repoName.toLowerCase()}`;
}

/**
 * In-flight PR creation claims, one per target repository. PR creation spans
 * several awaits (push, provider calls) during which the DO serves other
 * requests, so the persisted-artifact scan alone cannot enforce one PR per
 * repo — two concurrent requests could both pass it. Claims are in-memory on
 * the DO instance: a claim's lifetime is its request's, and both die with
 * the instance.
 */
export class PullRequestCreationClaims {
  private readonly inFlight = new Set<string>();

  /** True when the claim was acquired; false when creation is already in flight. */
  claim(repo: RepoIdentity): boolean {
    const key = claimKey(repo);
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  release(repo: RepoIdentity): void {
    this.inFlight.delete(claimKey(repo));
  }
}

/**
 * Session persistence operations required by pull request orchestration.
 */
export interface PullRequestRepository {
  getSession(): SessionRow | null;
  getSessionRepositories(): SessionRepositoryEntry[];
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
  /** DO-instance-scoped in-flight claims — must outlive individual requests. */
  claims: PullRequestCreationClaims;
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

    // Re-resolved here even though the handler already validated the target:
    // this is a sandbox-auth security boundary, so the service must not
    // trust its caller (defense in depth).
    let target: SessionRepositoryEntry;
    try {
      target = resolveSessionRepositoryTarget(input, this.deps.repository.getSessionRepositories());
    } catch (error) {
      if (error instanceof RepositoryNotMemberError) {
        return { kind: "error", status: 403, error: error.message };
      }
      if (
        error instanceof AmbiguousRepositoryTargetError ||
        error instanceof RepositoryPairValidationError
      ) {
        return { kind: "error", status: 400, error: error.message };
      }
      throw error;
    }
    const memberRow = target.row;
    const isPrimary = target.isPrimary;
    const targetRepo = { repoOwner: target.repoOwner, repoName: target.repoName };

    this.deps.log.info("Creating PR", {
      user_id: input.promptingUserId,
      repo_owner: targetRepo.repoOwner,
      repo_name: targetRepo.repoName,
    });

    if (!this.deps.claims.claim(targetRepo)) {
      return {
        kind: "error",
        status: 409,
        error: `A pull request is already being created for ${targetRepo.repoOwner}/${targetRepo.repoName} in this session.`,
      };
    }
    try {
      const sessionId = session.session_name || session.id;
      const generatedHeadBranch = generateBranchName(sessionId);

      // The claim above serializes in-flight creation; this scan catches PRs
      // persisted by earlier (completed) requests.
      if (findPrArtifactForRepo(this.deps.repository.listArtifacts(), targetRepo, isPrimary)) {
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
    } finally {
      this.deps.claims.release(targetRepo);
    }
  }

  private duplicatePrError(targetRepo: RepoIdentity): CreatePullRequestResult {
    return {
      kind: "error",
      status: 409,
      error: `A pull request has already been created for ${targetRepo.repoOwner}/${targetRepo.repoName} in this session.`,
    };
  }
}
