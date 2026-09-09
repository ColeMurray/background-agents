import type { Logger } from "../../../logger";
import type { SessionMessenger } from "../../messenger";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
import {
  preparePullRequestArtifactUpdate,
  pullRequestSnapshotSchema,
} from "../../pull-request-snapshot";
import {
  mapRepositoryTargetError,
  resolveSessionRepositoryTarget,
  type SessionRepositoryEntry,
} from "../../repository-target";
import type { ArtifactRepository } from "../../artifact-repository";
import type { ParticipantService } from "../../participant-service";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionRow } from "../../types";
import { z } from "zod";

const createPrRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  draft: z.boolean().optional(),
});

type CreatePrRequest = z.infer<typeof createPrRequestSchema>;

/**
 * HTTP boundary for the pull-request endpoints: PR creation, sandbox-reported
 * snapshot application, and the manual refresh trigger.
 */
export class PullRequestHandler {
  constructor(
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly participants: ParticipantService,
    private readonly artifactRepository: ArtifactRepository,
    private readonly messenger: SessionMessenger,
    private readonly getSessionUrl: (session: SessionRow) => string,
    private readonly createPullRequest: (
      input: CreatePullRequestInput,
      log: Logger
    ) => Promise<CreatePullRequestResult>,
    /** Kicks off a background read-through refresh. */
    private readonly triggerPullRequestRefresh: () => void,
    private readonly now: () => number = Date.now
  ) {}

  async createPr(request: Request, log: Logger): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parsed = createPrRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const body: CreatePrRequest = parsed.data;

    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    if (!session.repo_owner || !session.repo_name) {
      return Response.json(
        { error: "Pull requests require a repository context" },
        { status: 400 }
      );
    }

    // Membership is a security boundary (this route is reachable with
    // sandbox auth): naming a repo outside the session is 403, an
    // ambiguous or half-specified target is 400.
    let target: SessionRepositoryEntry;
    try {
      target = resolveSessionRepositoryTarget(
        { repoOwner: body.repoOwner, repoName: body.repoName },
        this.sessionCoreRepository.getSessionRepositories()
      );
    } catch (error) {
      const mapped = mapRepositoryTargetError(error);
      if (!mapped) throw error;
      return Response.json({ error: mapped.error }, { status: mapped.status });
    }

    const promptingParticipantResult = await this.participants.getPromptingParticipantForPR();
    if (!promptingParticipantResult.participant) {
      return Response.json(
        { error: promptingParticipantResult.error },
        { status: promptingParticipantResult.status }
      );
    }

    const promptingParticipant = promptingParticipantResult.participant;
    const authResolution = await this.participants.resolveAuthForPR(promptingParticipant);
    if ("error" in authResolution) {
      return Response.json({ error: authResolution.error }, { status: authResolution.status });
    }

    // Base-branch defaulting happens in the service (requested > target
    // repo's base branch > repo default), so the raw request value passes
    // through untouched.
    const result = await this.createPullRequest(
      {
        title: body.title,
        body: body.body,
        baseBranch: body.baseBranch,
        headBranch: body.headBranch,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        promptingUserId: promptingParticipant.user_id,
        promptingAuth: authResolution.auth,
        sessionUrl: this.getSessionUrl(session),
        draft: body.draft,
      },
      log
    );

    if (result.kind === "error") {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      state: result.state,
      headBranch: result.headBranch,
      baseBranch: result.baseBranch,
      updated: result.updated,
    });
  }

  /**
   * Transport shell for snapshot application (design §6): parse the
   * request, resolve the artifact, compute the update via the canonical
   * preparePullRequestArtifactUpdate, and perform the write + broadcast it
   * prescribes. Stale and materially identical snapshots answer
   * `{ applied: false }` — no write, no broadcast.
   */
  async pullRequestArtifactSnapshot(request: Request, url: URL): Promise<Response> {
    const artifactId = url.searchParams.get("artifactId");
    if (!artifactId) {
      return Response.json({ error: "artifactId query parameter is required" }, { status: 400 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parsed = pullRequestSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const artifact = this.artifactRepository.getArtifactById(artifactId);
    if (!artifact || artifact.type !== "pr") {
      return Response.json({ error: "Pull request artifact not found" }, { status: 404 });
    }

    const artifactUpdate = preparePullRequestArtifactUpdate(artifact, parsed.data, this.now());
    if (!artifactUpdate) {
      return Response.json({ applied: false });
    }

    this.artifactRepository.updateArtifact(artifact.id, artifactUpdate.update);
    this.messenger.broadcast({ type: "artifact_updated", artifact: artifactUpdate.artifact });
    return Response.json({ applied: true });
  }

  /**
   * Manual sync (design §5.3): fire the read-through refresh in the
   * background and return immediately — the endpoint never blocks on a
   * provider read.
   */
  refreshPullRequests(): Response {
    this.triggerPullRequestRefresh();
    return Response.json({ status: "refreshing" }, { status: 202 });
  }
}
