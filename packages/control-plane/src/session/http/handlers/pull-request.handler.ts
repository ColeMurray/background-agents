import type { SourceControlAuthContext } from "../../../source-control";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
import type { SessionRepositoryRow } from "../../repository";
import type { ParticipantRow, SessionRow } from "../../types";
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
  getSessionRepositories: () => SessionRepositoryRow[];
  getPromptingParticipantForPR: () => Promise<PromptingParticipantResult>;
  resolveAuthForPR: (participant: ParticipantRow) => Promise<ResolveAuthForPrResult>;
  getSessionUrl: (session: SessionRow) => string;
  createPullRequest: (input: CreatePullRequestInput) => Promise<CreatePullRequestResult>;
}

export interface PullRequestHandler {
  createPr: (request: Request) => Promise<Response>;
}

/**
 * Resolve and authorize the PR's target repository against the session's
 * member list (sessions predating member rows fall back to the scalar
 * mirror). Returns the member's canonical identity, or an error Response:
 * 400 when the target is ambiguous or half-specified, 403 when it names a
 * repo outside the session — creation is reachable with sandbox auth, so
 * this is a security boundary, not just input validation.
 */
function resolveTargetRepository(
  body: CreatePrRequest,
  scalarRepo: { repoOwner: string; repoName: string },
  memberRows: SessionRepositoryRow[]
): { repoOwner: string; repoName: string } | Response {
  const members =
    memberRows.length > 0
      ? memberRows.map((row) => ({ repoOwner: row.repo_owner, repoName: row.repo_name }))
      : [scalarRepo];

  if ((body.repoOwner == null) !== (body.repoName == null)) {
    return Response.json(
      { error: "repoOwner and repoName must be provided together" },
      { status: 400 }
    );
  }

  if (body.repoOwner == null || body.repoName == null) {
    if (members.length > 1) {
      const memberList = members.map((m) => `${m.repoOwner}/${m.repoName}`).join(", ");
      return Response.json(
        {
          error: `This session spans multiple repositories — specify repoOwner and repoName (one of: ${memberList})`,
        },
        { status: 400 }
      );
    }
    return members[0];
  }

  const requestedOwner = body.repoOwner.toLowerCase();
  const requestedName = body.repoName.toLowerCase();
  const match = members.find(
    (member) =>
      member.repoOwner.toLowerCase() === requestedOwner &&
      member.repoName.toLowerCase() === requestedName
  );
  if (!match) {
    return Response.json(
      { error: `Repository ${body.repoOwner}/${body.repoName} is not part of this session` },
      { status: 403 }
    );
  }
  return match;
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

      const target = resolveTargetRepository(
        body,
        { repoOwner: session.repo_owner, repoName: session.repo_name },
        deps.getSessionRepositories()
      );
      if (target instanceof Response) {
        return target;
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
  };
}
