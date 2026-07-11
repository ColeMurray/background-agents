import type { SessionArtifact } from "@open-inspect/shared";
import type { SourceControlAuthContext } from "../../../source-control";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
import { applyPullRequestSnapshot, pullRequestSnapshotSchema } from "../../pull-request-snapshot";
import {
  mapRepositoryTargetError,
  resolveSessionRepositoryTarget,
  type SessionRepositoryEntry,
} from "../../repository-target";
import type { UpdateArtifactData } from "../../repository";
import type { ArtifactRow, ParticipantRow, SessionRow } from "../../types";
import { z } from "zod";

const createPrRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
});

type CreatePrRequest = z.infer<typeof createPrRequestSchema>;

type PromptingParticipantResult =
  | { participant: ParticipantRow; error?: never; status?: never }
  | { participant?: never; error: string; status: number };

type ResolveAuthForPrResult =
  | { auth: SourceControlAuthContext | null; error?: never; status?: never }
  | { auth?: never; error: string; status: number };

export interface PullRequestHandlerDeps {
  getSession: () => SessionRow | null;
  getSessionRepositories: () => SessionRepositoryEntry[];
  getPromptingParticipantForPR: () => Promise<PromptingParticipantResult>;
  resolveAuthForPR: (participant: ParticipantRow) => Promise<ResolveAuthForPrResult>;
  getSessionUrl: (session: SessionRow) => string;
  createPullRequest: (input: CreatePullRequestInput) => Promise<CreatePullRequestResult>;
  getArtifactById: (artifactId: string) => ArtifactRow | null;
  updateArtifact: (artifactId: string, data: UpdateArtifactData) => void;
  broadcastArtifactUpdated: (artifact: SessionArtifact) => void;
  now: () => number;
}

export interface PullRequestHandler {
  createPr: (request: Request) => Promise<Response>;
  pullRequestArtifactSnapshot: (request: Request, url: URL) => Promise<Response>;
}

export function createPullRequestHandler(deps: PullRequestHandlerDeps): PullRequestHandler {
  return {
    async createPr(request: Request): Promise<Response> {
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

      const session = deps.getSession();
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
          deps.getSessionRepositories()
        );
      } catch (error) {
        const mapped = mapRepositoryTargetError(error);
        if (!mapped) throw error;
        return Response.json({ error: mapped.error }, { status: mapped.status });
      }

      const promptingParticipantResult = await deps.getPromptingParticipantForPR();
      if (!promptingParticipantResult.participant) {
        return Response.json(
          { error: promptingParticipantResult.error },
          { status: promptingParticipantResult.status }
        );
      }

      const promptingParticipant = promptingParticipantResult.participant;
      const authResolution = await deps.resolveAuthForPR(promptingParticipant);
      if ("error" in authResolution) {
        return Response.json({ error: authResolution.error }, { status: authResolution.status });
      }

      // Base-branch defaulting happens in the service (requested > target
      // repo's base branch > repo default), so the raw request value passes
      // through untouched.
      const result = await deps.createPullRequest({
        title: body.title,
        body: body.body,
        baseBranch: body.baseBranch,
        headBranch: body.headBranch,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        promptingUserId: promptingParticipant.user_id,
        promptingAuth: authResolution.auth,
        sessionUrl: deps.getSessionUrl(session),
      });

      if (result.kind === "error") {
        return Response.json({ error: result.error }, { status: result.status });
      }

      return Response.json({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        state: result.state,
      });
    },

    /**
     * Transport shell for the snapshot projection (design §6): parse the
     * request, resolve the artifact, and delegate to the canonical
     * applyPullRequestSnapshot. Stale and materially identical snapshots
     * answer `{ applied: false }` — no write, no broadcast.
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

      const artifact = deps.getArtifactById(artifactId);
      if (!artifact || artifact.type !== "pr") {
        return Response.json({ error: "Pull request artifact not found" }, { status: 404 });
      }

      const result = applyPullRequestSnapshot(
        {
          updateArtifact: deps.updateArtifact,
          broadcastArtifactUpdated: deps.broadcastArtifactUpdated,
          now: deps.now,
        },
        artifact,
        parsed.data
      );

      return Response.json(result);
    },
  };
}
