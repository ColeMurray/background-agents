import { toDisplayStatus, type SessionArtifact } from "@open-inspect/shared";
import type { SourceControlAuthContext } from "../../../source-control";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
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

/**
 * Mirrors PullRequestSnapshot (source-control/types.ts) — the wire body the
 * webhook and read-through paths push into the DO. Draft is only meaningful
 * while open (shared-contract invariant, same rule as the D1 CHECK).
 */
const pullRequestSnapshotSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    lifecycleState: z.enum(["open", "closed", "merged"]),
    isDraft: z.boolean(),
    headBranch: z.string(),
    baseBranch: z.string(),
    headSha: z.string().optional(),
    repoOwner: z.string(),
    repoName: z.string(),
    repositoryExternalId: z.string().optional(),
    providerUpdatedAt: z.number().optional(),
  })
  .refine((snapshot) => snapshot.lifecycleState === "open" || !snapshot.isDraft, {
    message: "isDraft is only valid while the pull request is open",
  });

type PullRequestSnapshotBody = z.infer<typeof pullRequestSnapshotSchema>;

/** Tolerant metadata read: malformed or non-object metadata degrades to {}. */
function parseArtifactMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge a snapshot into existing artifact metadata, preserving unknown legacy
 * keys and keeping the legacy `state` display key current for older clients.
 */
function mergeSnapshotMetadata(
  existing: Record<string, unknown>,
  snapshot: PullRequestSnapshotBody
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    number: snapshot.number,
    state: toDisplayStatus(snapshot),
    lifecycleState: snapshot.lifecycleState,
    isDraft: snapshot.isDraft,
    head: snapshot.headBranch,
    base: snapshot.baseBranch,
    repoOwner: snapshot.repoOwner,
    repoName: snapshot.repoName,
  };
  if (snapshot.headSha !== undefined) next.headSha = snapshot.headSha;
  if (snapshot.repositoryExternalId !== undefined) {
    next.repositoryExternalId = snapshot.repositoryExternalId;
  }
  if (snapshot.providerUpdatedAt !== undefined) {
    next.providerUpdatedAt = snapshot.providerUpdatedAt;
  }
  return next;
}

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
     * Applies a provider snapshot to the `pr` artifact mirror (design §6):
     * merge metadata, advance updated_at, broadcast one artifact_updated.
     * Stale (older providerUpdatedAt) and materially identical snapshots
     * no-op with `{ applied: false }` — no write, no broadcast.
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
      const snapshot = parsed.data;

      const artifact = deps.getArtifactById(artifactId);
      if (!artifact || artifact.type !== "pr") {
        return Response.json({ error: "Pull request artifact not found" }, { status: 404 });
      }

      const existing = parseArtifactMetadata(artifact.metadata);

      // Same monotonic rule as the D1 store's upsert guard: only a snapshot
      // strictly older than the stored provider timestamp is rejected; a
      // missing timestamp on either side is authoritative.
      const existingProviderUpdatedAt =
        typeof existing.providerUpdatedAt === "number" ? existing.providerUpdatedAt : null;
      if (
        snapshot.providerUpdatedAt !== undefined &&
        existingProviderUpdatedAt !== null &&
        snapshot.providerUpdatedAt < existingProviderUpdatedAt
      ) {
        return Response.json({ applied: false });
      }

      const nextMetadata = mergeSnapshotMetadata(existing, snapshot);
      const urlChanged = snapshot.url !== artifact.url;
      const metadataChanged = JSON.stringify(nextMetadata) !== JSON.stringify(existing);
      if (!urlChanged && !metadataChanged) {
        return Response.json({ applied: false });
      }

      const updatedAt = deps.now();
      deps.updateArtifact(artifactId, {
        url: snapshot.url,
        metadata: JSON.stringify(nextMetadata),
        updatedAt,
      });
      deps.broadcastArtifactUpdated({
        id: artifact.id,
        type: "pr",
        url: snapshot.url,
        metadata: nextMetadata,
        createdAt: artifact.created_at,
        updatedAt,
      });

      return Response.json({ applied: true });
    },
  };
}
