import { childFollowUpPromptRequestSchema } from "@open-inspect/shared/types/session-api";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { z } from "zod";
import { sessionStatusSchema } from "@open-inspect/shared/types/sessions";
import { parsePersistedSandboxSettings } from "../../../sandbox/settings";
import type { SessionMessenger } from "../../messenger";
import { PromptQueueFullError, SessionNotPromptableError } from "../../message-queue";
import type { MessageRepository } from "../../message-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { MessageService } from "../../services/message.service";
import type { SpawnContext } from "../../spawn-context";
import { activePromptAuthorSchema, type ActivePromptAuthor } from "../../active-prompt-author";
import type { ParticipantRow } from "../../types";

const parentPromptRequestSchema = childFollowUpPromptRequestSchema.extend({
  parentSessionId: z.string().min(1),
  author: activePromptAuthorSchema,
});

const childSessionUpdateBodySchema = z.object({
  childSessionId: z.string().min(1),
  status: sessionStatusSchema,
  title: z.string().nullable().optional(),
});

function resolvePromptAuthorParticipant(
  messageRepository: MessageRepository,
  participantRepository: ParticipantRepository
): ParticipantRow | Response {
  const processingMessage = messageRepository.getProcessingMessageAuthor();
  if (!processingMessage) {
    return Response.json(
      { error: "No active prompt found. Child operations must be triggered by an active prompt." },
      { status: 400 }
    );
  }
  const participant = participantRepository.getParticipantById(processingMessage.author_id);
  if (!participant) return Response.json({ error: "Prompt author not found" }, { status: 401 });
  return participant;
}

function toActivePromptAuthor(participant: ParticipantRow): ActivePromptAuthor {
  return {
    userId: participant.user_id,
    ...(participant.canonical_user_id ? { canonicalUserId: participant.canonical_user_id } : {}),
    scmUserId: participant.scm_user_id,
    scmLogin: participant.scm_login,
    scmName: participant.scm_name,
    scmEmail: participant.scm_email,
  };
}

/**
 * HTTP boundary for the parent/child session endpoints: spawn context and
 * prompt-author reads for child spawning, and the parent-prompt/status-update
 * callbacks children invoke. The child-summary read is served by
 * `ChildSummaryHandler`.
 */
export class ChildSessionsHandler {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly participantRepository: ParticipantRepository,
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly messenger: SessionMessenger,
    private readonly messageService: Pick<MessageService, "enqueuePrompt">
  ) {}

  getSpawnContext(): Response {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const promptAuthor = resolvePromptAuthorParticipant(
      this.messageRepository,
      this.participantRepository
    );
    if (promptAuthor instanceof Response) return promptAuthor;
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
      promptAuthor: {
        userId: promptAuthor.user_id,
        ...(promptAuthor.canonical_user_id
          ? { canonicalUserId: promptAuthor.canonical_user_id }
          : {}),
        scmUserId: promptAuthor.scm_user_id,
        scmLogin: promptAuthor.scm_login,
        scmName: promptAuthor.scm_name,
        scmEmail: promptAuthor.scm_email,
        scmAccessTokenEncrypted: promptAuthor.scm_access_token_encrypted,
        scmRefreshTokenEncrypted: promptAuthor.scm_refresh_token_encrypted,
        scmTokenExpiresAt: promptAuthor.scm_token_expires_at,
      },
    };

    return Response.json(context);
  }

  getActivePromptAuthor(): Response {
    if (!this.sessionCoreRepository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const author = resolvePromptAuthorParticipant(
      this.messageRepository,
      this.participantRepository
    );
    return author instanceof Response ? author : Response.json(toActivePromptAuthor(author));
  }

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

    const session = this.sessionCoreRepository.getSession();
    if (!session || session.parent_session_id !== parsed.data.parentSessionId) {
      return Response.json({ error: "Child session not found" }, { status: 404 });
    }
    if (!isSessionPromptable(session.status)) {
      return Response.json({ error: `Cannot prompt a ${session.status} session` }, { status: 409 });
    }
    try {
      return Response.json(
        await this.messageService.enqueuePrompt({
          content: parsed.data.content,
          authorId: parsed.data.author.userId,
          canonicalUserId: parsed.data.author.canonicalUserId ?? undefined,
          source: "agent",
          scmEnrichment: {
            userId: parsed.data.author.scmUserId,
            login: parsed.data.author.scmLogin,
            name: parsed.data.author.scmName,
            email: parsed.data.author.scmEmail,
            accessTokenEncrypted: null,
            refreshTokenEncrypted: null,
            tokenExpiresAt: null,
          },
        })
      );
    } catch (error) {
      if (error instanceof SessionNotPromptableError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof PromptQueueFullError) {
        return Response.json({ error: "Child prompt queue is full" }, { status: 429 });
      }
      throw error;
    }
  }

  async childSessionUpdate(request: Request): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json({ error: "childSessionId and status are required" }, { status: 400 });
    }
    const result = childSessionUpdateBodySchema.safeParse(rawBody);

    if (!result.success) {
      return Response.json({ error: "childSessionId and status are required" }, { status: 400 });
    }

    const body = result.data;

    this.messenger.broadcast({
      type: "child_session_update",
      childSessionId: body.childSessionId,
      status: body.status,
      title: body.title ?? null,
    });

    return Response.json({ ok: true });
  }
}
