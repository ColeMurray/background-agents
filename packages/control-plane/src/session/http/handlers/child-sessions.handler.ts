import { childFollowUpPromptRequestSchema, type SpawnContext } from "@open-inspect/shared";
import { z } from "zod";
import type { SessionStatus } from "../../../types";
import { parsePersistedSandboxSettings } from "../../../sandbox/settings";
import type { SessionMessenger } from "../../messenger";
import type { SessionRepository } from "../../repository";
import {
  ChildFollowUpError,
  type ChildFollowUpErrorReason,
  type ChildFollowUpService,
} from "../../services/child-follow-up.service";
import type { ArtifactRow, SandboxRow, SessionRow } from "../../types";
import {
  RECENT_EVENT_FETCH_LIMIT,
  buildChildSessionDetail,
  collectFinalResponseEventRows,
  parseChildSummaryOptions,
  type ChildSummaryFinalResponseInput,
  type ChildSummaryTrajectoryInput,
} from "./child-session-summary";

export interface ChildSessionsHandlerDeps {
  repository: Pick<
    SessionRepository,
    | "listParticipants"
    | "listArtifacts"
    | "listEventPage"
    | "getLatestTerminalMessage"
    | "getEventTimelinePage"
    | "getPendingOrProcessingCount"
  >;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
  messenger: SessionMessenger;
  childFollowUpService: ChildFollowUpService;
}

export interface ChildSessionsHandler {
  getSpawnContext: () => Response;
  getChildSummary: (url?: URL) => Response;
  parentPrompt: (request: Request) => Promise<Response>;
  childSessionUpdate: (request: Request) => Promise<Response>;
}

const parentPromptRequestSchema = childFollowUpPromptRequestSchema.extend({
  parentSessionId: z.string().min(1),
});

function childFollowUpErrorStatus(reason: ChildFollowUpErrorReason): 404 | 409 | 429 | 500 {
  switch (reason) {
    case "child_not_found":
      return 404;
    case "session_not_promptable":
      return 409;
    case "queue_full":
      return 429;
    case "owner_missing":
      return 500;
  }
}

export function createChildSessionsHandler(deps: ChildSessionsHandlerDeps): ChildSessionsHandler {
  return {
    getSpawnContext(): Response {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const participants = deps.repository.listParticipants();
      const owner = participants.find((participant) => participant.role === "owner");
      if (!owner) {
        return Response.json({ error: "No owner participant found" }, { status: 404 });
      }
      let sandboxTimeoutMs: number | undefined;
      try {
        sandboxTimeoutMs = parsePersistedSandboxSettings(session.sandbox_settings).sandboxTimeoutMs;
      } catch {
        sandboxTimeoutMs = undefined;
      }
      const context: SpawnContext = {
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        repoId: session.repo_id,
        model: session.model,
        reasoningEffort: session.reasoning_effort ?? null,
        baseBranch: session.base_branch,
        sandboxTimeoutMs,
        owner: {
          userId: owner.user_id,
          ...(owner.canonical_user_id ? { canonicalUserId: owner.canonical_user_id } : {}),
          scmUserId: owner.scm_user_id,
          scmLogin: owner.scm_login,
          scmName: owner.scm_name,
          scmEmail: owner.scm_email,
          scmAccessTokenEncrypted: owner.scm_access_token_encrypted,
          scmRefreshTokenEncrypted: owner.scm_refresh_token_encrypted,
          scmTokenExpiresAt: owner.scm_token_expires_at,
        },
      };

      return Response.json(context);
    },

    getChildSummary(url?: URL): Response {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const parsedOptions = parseChildSummaryOptions(url);
      if (!parsedOptions.ok) {
        return Response.json({ error: parsedOptions.error }, { status: 400 });
      }

      const options = parsedOptions.options;
      const sandbox = deps.getSandbox();
      const artifacts = deps.repository.listArtifacts();
      const recentEventRows = deps.repository.listEventPage({
        limit: RECENT_EVENT_FETCH_LIMIT,
      }).events;
      let finalResponse: ChildSummaryFinalResponseInput | undefined;
      let trajectory: ChildSummaryTrajectoryInput | undefined;

      if (options.includeFinalResponse) {
        const terminalMessage = deps.repository.getLatestTerminalMessage();
        const collectedEvents = terminalMessage
          ? collectFinalResponseEventRows(deps.repository, terminalMessage.id)
          : { eventRows: [], eventLimitReached: false };
        finalResponse = { message: terminalMessage, ...collectedEvents };
      }

      if (options.includeTrajectory) {
        const page = deps.repository.getEventTimelinePage({
          limit: options.trajectoryLimit,
          cursor: options.trajectoryCursor ?? undefined,
        });
        trajectory = {
          eventRows: page.events,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          limit: options.trajectoryLimit,
        };
      }

      return Response.json(
        buildChildSessionDetail({
          session,
          sandbox,
          publicSessionId: deps.getPublicSessionId(session),
          artifacts,
          recentEventRows,
          hasUnfinishedPrompt: deps.repository.getPendingOrProcessingCount() > 0,
          parseArtifactMetadata: deps.parseArtifactMetadata,
          finalResponse,
          trajectory,
        })
      );
    },

    async parentPrompt(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid prompt body" }, { status: 400 });
      }
      const parsed = parentPromptRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const reason = parsed.error.issues[0]?.message;
        return Response.json(
          { error: reason ? `Invalid prompt body: ${reason}` : "Invalid prompt body" },
          { status: 400 }
        );
      }

      try {
        return Response.json(await deps.childFollowUpService.enqueue(parsed.data));
      } catch (error) {
        if (!(error instanceof ChildFollowUpError)) throw error;
        return Response.json(
          { error: error.message },
          { status: childFollowUpErrorStatus(error.reason) }
        );
      }
    },

    async childSessionUpdate(request: Request): Promise<Response> {
      const body = (await request.json()) as {
        childSessionId: string;
        status: SessionStatus;
        title: string | null;
      };

      if (!body.childSessionId || !body.status) {
        return Response.json({ error: "childSessionId and status are required" }, { status: 400 });
      }

      deps.messenger.broadcast({
        type: "child_session_update",
        childSessionId: body.childSessionId,
        status: body.status,
        title: body.title ?? null,
      });

      return Response.json({ ok: true });
    },
  };
}
