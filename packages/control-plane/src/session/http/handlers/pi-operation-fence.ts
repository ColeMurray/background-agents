import type { MessageRepository } from "../../message-repository";
import { piControlRequestIdFromMessageId } from "../../pi-control-message-id";
import type { PiControlRepository } from "../../pi-control-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

/** What the operation fence reads. */
export interface PiOperationFenceOptions {
  sessions: Pick<SessionCoreRepository, "getSession">;
  messages: Pick<MessageRepository, "getProcessingMessage">;
  controls: Pick<PiControlRepository, "isActiveOperation">;
}

/**
 * Whether a request belongs to a live Pi turn of this session.
 *
 * The fence is an activity check, not an identity check. Identity comes from
 * the Durable Object binding the caller used to address this session; the
 * fence adds the second half: the request must name a turn of this session
 * that is running now, so a capability cannot be exercised outside a turn.
 *
 * One implementation, so the Pi bridge and the memory gateway agree on what
 * "live" means.
 */
export function createPiOperationFence(
  options: PiOperationFenceOptions
): (request: Request) => boolean {
  return (request: Request) => {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (options.sessions.getSession()?.harness !== "pi" || !operationId) return false;
    if (options.messages.getProcessingMessage()?.id === operationId) return true;
    // A control's turn is the session's message "pi-control:<requestId>", so
    // the operation id names the control it belongs to.
    const controlRequestId = piControlRequestIdFromMessageId(operationId);
    return options.controls.isActiveOperation(controlRequestId ?? operationId);
  };
}
