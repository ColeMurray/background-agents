import { generateBranchName, type ManualPullRequestArtifactMetadata } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { resolveHeadBranchForPr } from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
} from "../source-control";
import type { ArtifactRow, SessionRow } from "./types";

/**
 * Inputs required to create a PR once caller identity/auth are already resolved.
 */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
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
  | { kind: "manual"; createPrUrl: string; headBranch: string; baseBranch: string }
  | { kind: "error"; status: number; error: string };

export type PushBranchResult = { success: true } | { success: false; error: string };

/**
 * Session persistence operations required by pull request orchestration.
 */
export interface PullRequestRepository {
  getSession(): SessionRow | null;
  updateSessionBranch(sessionId: string, branchName: string): void;
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
  pushBranchToRemote: (headBranch: string, pushSpec: GitPushSpec) => Promise<PushBranchResult>;
  broadcastArtifactCreated: (artifact: {
    id: string;
    type: "pr" | "branch";
    url: string;
    prNumber?: number;
  }) => void;
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

    this.deps.log.info("Creating PR", { user_id: input.promptingUserId });

    try {
      const sessionId = session.session_name || session.id;
      const generatedHeadBranch = generateBranchName(sessionId);

      const initialArtifacts = this.deps.repository.listArtifacts();
      const existingPrArtifact = initialArtifacts.find((artifact) => artifact.type === "pr");
      if (existingPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
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
        owner: session.repo_owner,
        name: session.repo_name,
      });
      const baseBranch = input.baseBranch || repoInfo.defaultBranch;
      const branchResolution = resolveHeadBranchForPr({
        requestedHeadBranch: input.headBranch,
        sessionBranchName: session.branch_name,
        generatedBranchName: generatedHeadBranch,
        baseBranch,
      });
      const headBranch = branchResolution.headBranch;
      this.deps.log.info("Resolved PR head branch", {
        requested_head_branch: input.headBranch ?? null,
        session_branch_name: session.branch_name,
        generated_head_branch: generatedHeadBranch,
        resolved_head_branch: headBranch,
        resolution_source: branchResolution.source,
        base_branch: baseBranch,
      });
      const pushSpec = this.deps.sourceControlProvider.buildGitPushSpec({
        owner: session.repo_owner,
        name: session.repo_name,
        sourceRef: "HEAD",
        targetBranch: headBranch,
        auth: pushAuth,
        force: true,
      });

      const pushResult = await this.deps.pushBranchToRemote(headBranch, pushSpec);
      if (!pushResult.success) {
        return { kind: "error", status: 500, error: pushResult.error };
      }

      this.deps.repository.updateSessionBranch(session.id, headBranch);

      const latestArtifacts = this.deps.repository.listArtifacts();
      const latestPrArtifact = latestArtifacts.find((artifact) => artifact.type === "pr");
      if (latestPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
      }

      if (!input.promptingAuth) {
        return this.buildManualPrFallbackResult(session, headBranch, baseBranch, latestArtifacts);
      }

      const fullBody = input.body + `\n\n---\n*Created with [Open-Inspect](${input.sessionUrl})*`;

      const prResult = await this.deps.sourceControlProvider.createPullRequest(
        input.promptingAuth,
        {
          repository: repoInfo,
          title: input.title,
          body: fullBody,
          sourceBranch: headBranch,
          targetBranch: baseBranch,
        }
      );

      const artifactId = this.deps.generateId();
      const now = Date.now();
      this.deps.repository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: JSON.stringify({
          number: prResult.id,
          state: prResult.state,
          head: headBranch,
          base: baseBranch,
        }),
        createdAt: now,
      });

      this.deps.broadcastArtifactCreated({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        prNumber: prResult.id,
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
   * Reuses an existing manual PR artifact URL for the same branch when present.
   */
  private findExistingManualPrUrl(
    artifacts: ArtifactRow[],
    headBranch: string,
    fallbackUrl: string
  ): { artifactId: string; createPrUrl: string } | null {
    for (const artifact of artifacts) {
      if (artifact.type !== "branch" || !artifact.metadata) {
        continue;
      }

      try {
        const metadata = JSON.parse(artifact.metadata) as Record<string, unknown>;
        if (metadata.mode !== "manual_pr" || metadata.head !== headBranch) {
          continue;
        }

        const metadataUrl = metadata.createPrUrl;
        let createPrUrl = fallbackUrl;

        if (typeof metadataUrl === "string" && metadataUrl.length > 0) {
          createPrUrl = metadataUrl;
        } else if (artifact.url && artifact.url.length > 0) {
          createPrUrl = artifact.url;
        }

        return {
          artifactId: artifact.id,
          createPrUrl,
        };
      } catch (error) {
        this.deps.log.warn("Invalid artifact metadata JSON", {
          artifact_id: artifact.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  /**
   * Creates or reuses a manual PR fallback artifact and returns manual response payload.
   */
  private buildManualPrFallbackResult(
    session: SessionRow,
    headBranch: string,
    baseBranch: string,
    artifacts: ArtifactRow[]
  ): CreatePullRequestResult {
    const manualCreatePrUrl = this.deps.sourceControlProvider.buildManualPullRequestUrl({
      owner: session.repo_owner,
      name: session.repo_name,
      sourceBranch: headBranch,
      targetBranch: baseBranch,
    });

    const existing = this.findExistingManualPrUrl(artifacts, headBranch, manualCreatePrUrl);
    if (existing) {
      this.deps.log.info("Using manual PR fallback", {
        head_branch: headBranch,
        base_branch: baseBranch,
        session_id: session.session_name || session.id,
        existing_artifact_id: existing.artifactId,
      });
      return {
        kind: "manual",
        createPrUrl: existing.createPrUrl,
        headBranch,
        baseBranch,
      };
    }

    const artifactId = this.deps.generateId();
    const now = Date.now();
    const metadata: ManualPullRequestArtifactMetadata = {
      head: headBranch,
      base: baseBranch,
      mode: "manual_pr",
      createPrUrl: manualCreatePrUrl,
      provider: this.deps.sourceControlProvider.name,
    };
    this.deps.repository.createArtifact({
      id: artifactId,
      type: "branch",
      url: manualCreatePrUrl,
      metadata: JSON.stringify(metadata),
      createdAt: now,
    });

    this.deps.broadcastArtifactCreated({
      id: artifactId,
      type: "branch",
      url: manualCreatePrUrl,
    });

    this.deps.log.info("Using manual PR fallback", {
      head_branch: headBranch,
      base_branch: baseBranch,
      session_id: session.session_name || session.id,
      artifact_id: artifactId,
    });

    return {
      kind: "manual",
      createPrUrl: manualCreatePrUrl,
      headBranch,
      baseBranch,
    };
  }
}
