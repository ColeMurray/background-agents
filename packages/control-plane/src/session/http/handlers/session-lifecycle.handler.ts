import type { WebSocketManager } from "../../../sandbox/lifecycle/manager";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { MessageRepository } from "../../message-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { resolvePublicSessionId } from "../../public-session-id";
import { normalizeSessionTitle, type SessionTitleUpdateResult } from "../../title";
import { z } from "zod";
import { isSessionInactive } from "@open-inspect/shared/types/session-activity";

/**
 * There is nothing to cancel once a session is no longer live work.
 *
 * Expressed as the negation of the shared predicate rather than its own member
 * list: this site and the two others that asked this question kept separate
 * copies of an identical set, which bought nothing and could only drift. If
 * cancellability ever genuinely diverges from liveness, change it here — the
 * name already says which question is being answered.
 */
function isCancellable(status: SessionStatus): boolean {
  return !isSessionInactive(status);
}

function sessionTitleUpdateStatus(
  result: Extract<SessionTitleUpdateResult, { ok: false }>
): 400 | 404 | 409 {
  switch (result.reason) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "already_set":
      return 409;
  }
}

const titleUpdateBodySchema = z.object({
  title: z.string().optional(),
});

type TitleUpdateBody = z.infer<typeof titleUpdateBodySchema>;

/**
 * HTTP boundary for the session lifecycle endpoints: init, state reads, title
 * updates, archive/unarchive, draft expiry, and cancellation.
 */
export class SessionLifecycleHandler {
  /** Create the session lifecycle HTTP handler with its persistence and lifecycle services. */
  constructor(
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly messageRepository: MessageRepository,
    private readonly statusService: SessionStatusService,
    private readonly titleService: SessionTitleService,
    private readonly sockets: WebSocketManager,
    private readonly durableObjectId: string,
    private readonly cancelSession: () => Promise<void>
  ) {}

  getState(): Response {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    const sandbox = this.sandboxRepository.getSandbox();

    return Response.json({
      id: resolvePublicSessionId(session, this.durableObjectId),
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      baseBranch: session.base_branch,
      branchName: session.branch_name,
      baseSha: session.base_sha,
      currentSha: session.current_sha,
      opencodeSessionId: session.opencode_session_id,
      status: session.status,
      model: session.model,
      reasoningEffort: session.reasoning_effort ?? undefined,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      sandbox: sandbox
        ? {
            id: sandbox.id,
            modalSandboxId: sandbox.modal_sandbox_id,
            status: sandbox.status,
            gitSyncStatus: sandbox.git_sync_status,
            lastHeartbeat: sandbox.last_heartbeat,
          }
        : null,
    });
  }

  /** Update the title after route-level lifecycle authorization has succeeded. */
  async updateTitle(request: Request): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parseResult = titleUpdateBodySchema.safeParse(raw);
    if (!parseResult.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const body: TitleUpdateBody = parseResult.data;

    const normalizedTitle = normalizeSessionTitle(body.title);
    if (!normalizedTitle.ok) {
      return Response.json({ error: normalizedTitle.error }, { status: 400 });
    }

    const result = this.titleService.applySessionTitleUpdate(normalizedTitle.title, {
      onlyIfUnset: false,
    });
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: sessionTitleUpdateStatus(result) });
    }

    return Response.json({ title: result.title });
  }

  /** Archive the session after route-level lifecycle authorization has succeeded. */
  async archive(): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status === "cancelled") {
      return Response.json({ error: "Cancelled sessions cannot be archived" }, { status: 409 });
    }

    if (this.messageRepository.getPendingOrProcessingCount() > 0) {
      return Response.json({ error: "Cannot archive a session with queued work" }, { status: 409 });
    }

    await this.statusService.transition("archived");

    return Response.json({ status: "archived" });
  }

  /**
   * Retire a warm session that never received a prompt.
   *
   * The web client warms a session on the first keystroke, so navigating away
   * without submitting leaves a `created` row whose sandbox idles out — and no
   * other transition reaches it, because `active` needs an enqueued prompt and
   * the terminal statuses need a finished execution.
   *
   * The sweep selects candidates from the D1 index, which it may have read
   * before a prompt arrived. Re-checking here is what makes that safe: the
   * Durable Object is the authority on the session's own state and runs
   * single-threaded, so a session that started work in the meantime is left
   * alone rather than archived out from under its author.
   */
  async expireDraft(): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "created") {
      // Reaching here means the index still reads `created` while this session
      // has moved on — which is exactly what happens when an earlier
      // transition's D1 projection failed (they are logged and swallowed).
      // Repairing the mirror is what stops the row being selected instead of
      // being retried every sweep forever.
      await this.statusService.repairIndexStatus();
      return Response.json({ outcome: "not_draft", status: session.status });
    }

    if (
      this.messageRepository.getPendingOrProcessingCount() > 0 ||
      this.messageRepository.getMessageCount() > 0
    ) {
      // A session holding messages while still `created` is a broken aggregate:
      // enqueueing a prompt inserts the message and transitions to `active` in
      // the same Durable Object turn, so current code cannot produce this. It
      // survives only on rows predating that guarantee, and answering without
      // changing anything is what let them pin the head of the sweep's
      // oldest-first batch forever. Settle the status to what the messages say
      // instead. A queued prompt is left for the dispatch timeout rather than
      // archived: archiving discards a real request, and `archived` is not
      // promptable, so the author could not resume it either.
      const settled = await this.statusService.settleFromMessageState();
      return Response.json({ outcome: "has_work", status: settled });
    }

    await this.statusService.transition("archived");

    return Response.json({ outcome: "archived", status: "archived" });
  }

  /** Restore the session after route-level lifecycle authorization has succeeded. */
  async unarchive(): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "archived") {
      return Response.json({ error: "Session is not archived" }, { status: 409 });
    }

    // Restoring, not starting: unarchive returns the session to whatever its
    // messages already imply. Asserting "active" here claimed work that does
    // not exist, and no settle path would ever correct it — they all run off
    // execution events, so an idle session sat in the in-progress group until
    // someone prompted it again.
    const settled = await this.statusService.settleFromMessageState();

    return Response.json({ status: settled });
  }

  async cancel(): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (!isCancellable(session.status)) {
      return Response.json({ error: `Session already ${session.status}` }, { status: 409 });
    }

    await this.cancelSession();

    const sandbox = this.sandboxRepository.getSandbox();
    if (sandbox && sandbox.status !== "stopped" && sandbox.status !== "failed") {
      if (this.sockets.getSandboxWebSocket()) {
        this.sockets.sendToSandbox({ type: "shutdown" });
      }
      this.sandboxRepository.updateSandboxStatus("stopped");
    }

    return Response.json({ status: "cancelled" });
  }
}
