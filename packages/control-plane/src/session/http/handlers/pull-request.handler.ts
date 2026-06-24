import type { SourceControlAuthContext } from "../../../source-control";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
import type { ParticipantRow, SessionRow } from "../../types";
import { z } from "zod";

const createPrRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  draft: z.boolean().optional(),
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
  getPromptingParticipantForPR: () => Promise<PromptingParticipantResult>;
  resolveAuthForPR: (participant: ParticipantRow) => Promise<ResolveAuthForPrResult>;
  getSessionUrl: (session: SessionRow) => string;
  createPullRequest: (input: CreatePullRequestInput) => Promise<CreatePullRequestResult>;
}

export interface PullRequestHandler {
  createPr: (request: Request) => Promise<Response>;
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

      const result = await deps.createPullRequest({
        ...body,
        baseBranch: body.baseBranch || session.base_branch,
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
