import { generateBranchName } from "@open-inspect/shared/git";
import type { ScmSettings } from "@open-inspect/shared/types/integrations";
import { toDisplayStatus } from "@open-inspect/shared/types/artifacts";
import type {
  SessionPullRequestRecord,
  SessionPullRequestStore,
} from "../db/session-pull-request-store";
import type { Logger } from "../logger";
import {
  normalizeBranchName,
  resolveHeadBranchForPr,
  sanitizeBranchName,
  type ResolveHeadBranchForPrResult,
} from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
  type PullRequestSnapshot,
} from "../source-control";
import type { SessionMessenger } from "./messenger";
import type { ArtifactRepository } from "./artifact-repository";
import { listPrArtifactsForHead, type PrArtifactHeadMatch } from "./pr-artifacts";
import {
  mergeSnapshotMetadata,
  snapshotToRecord,
  type PullRequestSnapshotInput,
} from "./pull-request-snapshot";
import { applyPullRequestSnapshot } from "./pull-request-snapshot-apply";
import {
  mapRepositoryTargetError,
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
  /**
   * Whether to open the PR in draft mode. When configured, the SCM setting
   * "always use draft mode" overrides.
   */
  draft?: boolean;
}

export type CreatePullRequestResult =
  | {
      kind: "created";
      prNumber: number;
      prUrl: string;
      state: "open" | "closed" | "merged" | "draft";
      /** Resolved head (source) branch the PR is created from. */
      headBranch: string;
      /** Resolved base (target) branch the PR merges into. */
      baseBranch: string;
      /**
       * True when an open PR already existed for the head branch and was
       * reused: the branch was force-pushed and no new PR was created.
       */
      updated: boolean;
    }
  | { kind: "error"; status: number; error: string };

export type PushBranchResult = { success: true } | { success: false; error: string };

/**
 * A PR-creation failure with a caller-facing HTTP status. Thrown by internal
 * steps; createPullRequest's boundary catch maps it into the error result.
 */
class PullRequestCreationError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PullRequestCreationError";
  }
}

/** An open PR already carrying the resolved head branch — reused instead of
 * creating a duplicate. */
interface ExistingOpenPullRequest {
  prNumber: number;
  prUrl: string;
  state: "open" | "closed" | "merged" | "draft";
  baseBranch: string;
}

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
}

/**
 * Durable-object adapters that bridge runtime concerns into the service.
 */
export interface PullRequestServiceDeps {
  repository: PullRequestRepository;
  artifactRepository: ArtifactRepository;
  /** DO-instance-scoped in-flight claims — must outlive individual requests. */
  claims: PullRequestCreationClaims;
  sourceControlProvider: SourceControlProvider;
  log: Logger;
  generateId: () => string;
  pushBranchToRemote: (pushSpec: GitPushSpec) => Promise<PushBranchResult>;
  messenger: SessionMessenger;
  /** Display name used in the PR body footer (e.g. "Created with [name](url)"). */
  appName: string;
  /**
   * D1 authority store for session PR records (design §4). Absent when the
   * deployment has no D1 binding; the write is best-effort either way.
   */
  sessionPullRequests?: Pick<SessionPullRequestStore, "upsert">;
  /** Resolves SCM policy for the pull request's target repository. */
  resolveScmSettings: (repo: RepoIdentity) => Promise<ScmSettings>;
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
      const mapped = mapRepositoryTargetError(error);
      if (!mapped) throw error;
      return { kind: "error", ...mapped };
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

      let scmSettings: ScmSettings;
      try {
        scmSettings = await this.deps.resolveScmSettings(targetRepo);
      } catch (error) {
        this.deps.log.error("Failed to resolve pull request SCM policy", {
          repo_owner: targetRepo.repoOwner,
          repo_name: targetRepo.repoName,
          error: error instanceof Error ? error : String(error),
        });
        return {
          kind: "error",
          status: 503,
          error: "Pull request policy is temporarily unavailable",
        };
      }
      const draft = scmSettings.alwaysUseDraftMode === true || (input.draft ?? false);

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
      // Base: requested > the entry's base branch (the row's, or the scalar
      // mirror's for sessions without member rows) > repo default.
      const baseBranch = input.baseBranch || target.baseBranch || repoInfo.defaultBranch;
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

      // The claim above serializes in-flight creation; this scan catches PRs
      // persisted by earlier (completed) requests. Only a PR on the same head
      // branch conflicts — each branch carries its own pull request.
      const headMatches = listPrArtifactsForHead(
        this.deps.artifactRepository.listArtifacts(),
        targetRepo,
        isPrimary,
        { headBranch: sanitizedHeadBranch, generatedHeadBranch }
      );
      const existingOpenPr = await this.resolveExistingOpenPullRequest(
        headMatches,
        targetRepo,
        sessionId,
        {
          sanitizedHeadBranch,
          generatedHeadBranch,
          resolutionSource: branchResolution.source,
          requestedBaseBranch: input.baseBranch,
          resolvedBaseBranch: baseBranch,
        }
      );

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
      this.deps.messenger.broadcast({
        type: "session_branch",
        branchName: sanitizedHeadBranch,
        repoOwner: targetRepo.repoOwner,
        repoName: targetRepo.repoName,
      });

      if (existingOpenPr) {
        return {
          kind: "created",
          prNumber: existingOpenPr.prNumber,
          prUrl: existingOpenPr.prUrl,
          state: existingOpenPr.state,
          headBranch: sanitizedHeadBranch,
          baseBranch: existingOpenPr.baseBranch,
          updated: true,
        };
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
        draft,
        labels: scmSettings.pullRequestLabel ? [scmSettings.pullRequestLabel] : undefined,
      });

      const artifactId = this.deps.generateId();
      const now = Date.now();
      // The one PR lifecycle snapshot mapping (pull-request-snapshot.ts):
      // artifact metadata and the D1 record both derive from this snapshot,
      // so creation cannot drift from the update paths' field mapping.
      const snapshot: PullRequestSnapshotInput = {
        number: prResult.id,
        url: prResult.webUrl,
        lifecycleState: prResult.lifecycleState,
        isDraft: prResult.isDraft,
        headBranch: sanitizedHeadBranch,
        baseBranch,
        headSha: prResult.headSha,
        repoOwner: targetRepo.repoOwner,
        repoName: targetRepo.repoName,
        repositoryExternalId: prResult.repositoryExternalId,
        providerUpdatedAt: prResult.providerUpdatedAt,
      };
      const artifactMetadata = mergeSnapshotMetadata({}, snapshot);
      this.deps.artifactRepository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: JSON.stringify(artifactMetadata),
        createdAt: now,
      });

      await this.writeSessionPullRequestRecord(
        snapshotToRecord(snapshot, { artifactId, sessionId, createdAt: now, updatedAt: now })
      );

      this.deps.messenger.broadcast({
        type: "artifact_created",
        artifact: {
          id: artifactId,
          type: "pr",
          url: prResult.webUrl,
          metadata: artifactMetadata,
          createdAt: now,
          updatedAt: now,
        },
      });

      return {
        kind: "created",
        prNumber: prResult.id,
        prUrl: prResult.webUrl,
        // The provider returns only status facts; the display state is
        // derived here, at the response boundary.
        state: toDisplayStatus(prResult),
        headBranch: sanitizedHeadBranch,
        baseBranch,
        updated: false,
      };
    } catch (error) {
      this.deps.log.error("PR creation failed", {
        error: error instanceof Error ? error : String(error),
      });

      if (error instanceof PullRequestCreationError) {
        return { kind: "error", status: error.status, error: error.message };
      }

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

  /**
   * Best-effort creation write to the D1 authority record. Failure is logged
   * and swallowed: the DO artifact is already persisted, and the first
   * webhook or read-through repairs a missing record (design §5).
   */
  private async writeSessionPullRequestRecord(record: SessionPullRequestRecord): Promise<void> {
    const store = this.deps.sessionPullRequests;
    if (!store) return;
    try {
      await store.upsert(record);
    } catch (error) {
      this.deps.log.error("Failed to write session pull request record", {
        artifact_id: record.artifactId,
        pr_number: record.prNumber,
        repo_owner: record.repoOwner,
        repo_name: record.repoName,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Decide what the existing PR artifacts on the resolved head branch mean
   * for this request: reuse one (the caller force-pushes and reports it as
   * updated), or create anyway. A PR's identity is (repo, head, base), so
   * every stored-open candidate is walked — resolving each against the
   * provider's live state, since artifact metadata only hears about merges
   * from webhooks or the read-through refresh — rather than letting artifact
   * recency pick a winner.
   */
  private async resolveExistingOpenPullRequest(
    matches: PrArtifactHeadMatch[],
    targetRepo: RepoIdentity,
    sessionId: string,
    head: {
      sanitizedHeadBranch: string;
      generatedHeadBranch: string;
      resolutionSource: ResolveHeadBranchForPrResult["source"];
      requestedBaseBranch: string | undefined;
      /** Display fallback when neither live nor stored base is known. */
      resolvedBaseBranch: string;
    }
  ): Promise<ExistingOpenPullRequest | null> {
    // Stored-merged/closed artifacts released their head; stored-open (or
    // state-less legacy) candidates may still be holding the branch.
    const viable = matches.filter(
      (candidate) => candidate.lifecycleState === null || candidate.lifecycleState === "open"
    );

    // Reusing (or replacing) a PR force-pushes the sandbox checkout over its
    // head, so proceeding is only safe when the head IS the checkout: an
    // explicitly requested branch (the tool derives it from HEAD), or the
    // generated session branch (whose content is by construction whatever
    // HEAD force-pushes onto it). A stored custom branch reached via
    // fallback — e.g. the top of a stack recorded as the last-pushed branch —
    // holds content this request never saw, and pushing over it would
    // destroy that PR.
    const headIsCheckout =
      head.resolutionSource === "request" ||
      normalizeBranchName(head.sanitizedHeadBranch) ===
        normalizeBranchName(head.generatedHeadBranch);

    for (const candidate of viable) {
      // Unverifiable legacy candidates are handled after the walk.
      if (candidate.prNumber === null || candidate.artifact.url === null) continue;

      // Prefer the provider's live state, but a failed read falls back to
      // the stored facts: reusing a PR that turns out closed is recoverable,
      // opening a duplicate is not.
      let live: PullRequestSnapshot | null = null;
      try {
        live = await this.deps.sourceControlProvider.getPullRequest({
          owner: targetRepo.repoOwner,
          name: targetRepo.repoName,
          number: candidate.prNumber,
          repositoryExternalId: candidate.repositoryExternalId ?? undefined,
        });
      } catch (error) {
        this.deps.log.warn("Could not read live PR state; using the stored artifact's", {
          pr_number: candidate.prNumber,
          repo_owner: targetRepo.repoOwner,
          repo_name: targetRepo.repoName,
          error: error instanceof Error ? error : String(error),
        });
      }

      // A merged or closed PR releases its head branch (the
      // follow-up-after-merge flow). Heal the stale-open state that led here
      // and keep walking — an older PR may still hold the branch.
      if (live && live.lifecycleState !== "open") {
        await this.applyLiveSnapshot(candidate.artifact, live, sessionId);
        continue;
      }

      if (!headIsCheckout) {
        throw new PullRequestCreationError(
          409,
          `An open pull request (#${candidate.prNumber}) already exists for branch "${head.sanitizedHeadBranch}" in ${targetRepo.repoOwner}/${targetRepo.repoName}. Check out that branch to update it, or create a new branch to open a separate pull request.`
        );
      }

      // An explicitly different base asks for a separate PR from the same
      // head (providers allow one open PR per head/base pair), so this open
      // candidate is not the request's PR — but a later candidate may carry
      // the requested pairing. Without an explicit base the candidate's base
      // stands, whatever it is: a stacked PR's base is not the session
      // default, and a follow-up call must not be read as a retarget.
      const knownBase = live?.baseBranch ?? candidate.baseBranch;
      if (
        head.requestedBaseBranch !== undefined &&
        knownBase !== null &&
        normalizeBranchName(head.requestedBaseBranch) !== normalizeBranchName(knownBase)
      ) {
        continue;
      }

      return {
        prNumber: candidate.prNumber,
        prUrl: live?.url ?? candidate.artifact.url,
        state: toDisplayStatus(live ?? { lifecycleState: "open", isDraft: candidate.isDraft }),
        baseBranch: knownBase ?? head.resolvedBaseBranch,
      };
    }

    // Pre-lifecycle-tracking metadata without a PR number (or URL) cannot be
    // referenced or verified, so such a candidate keeps the head claimed
    // unless a verifiable PR was already reused above.
    if (
      viable.some((candidate) => candidate.prNumber === null || candidate.artifact.url === null)
    ) {
      throw new PullRequestCreationError(
        409,
        `A pull request has already been created for ${targetRepo.repoOwner}/${targetRepo.repoName} in this session.`
      );
    }

    return null;
  }

  /**
   * The canonical snapshot application (authority-then-mirror with an
   * apply-time re-read — the same sequence the read-through refresh and the
   * webhook snapshot push perform), plus the broadcast it prescribes.
   */
  private async applyLiveSnapshot(
    artifact: ArtifactRow,
    live: PullRequestSnapshot,
    sessionId: string
  ): Promise<void> {
    const applied = await applyPullRequestSnapshot(
      {
        artifactRepository: this.deps.artifactRepository,
        sessionPullRequests: this.deps.sessionPullRequests ?? null,
      },
      { artifactId: artifact.id, sessionId, artifactCreatedAt: artifact.created_at },
      live
    );
    if (applied.recordWriteError !== null) {
      this.deps.log.error("Failed to write session pull request record", {
        artifact_id: artifact.id,
        pr_number: live.number,
        repo_owner: live.repoOwner,
        repo_name: live.repoName,
        error:
          applied.recordWriteError instanceof Error
            ? applied.recordWriteError
            : String(applied.recordWriteError),
      });
    }
    if (applied.updatedArtifact) {
      this.deps.messenger.broadcast({
        type: "artifact_updated",
        artifact: applied.updatedArtifact,
      });
    }
  }
}
