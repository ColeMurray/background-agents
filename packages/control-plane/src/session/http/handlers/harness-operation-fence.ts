import type { MessageRepository } from "../../message-repository";

/** What the operation fence reads. */
export interface HarnessOperationFenceOptions {
  isHarnessSession(): boolean;
  messages: Pick<MessageRepository, "getProcessingMessage">;
  controls: { isActiveOperation(requestId: string): boolean };
  operationId(request: Request): string | null;
  controlRequestId(operationId: string): string | null;
}

/**
 * Whether a request belongs to a live in-process turn of this session.
 *
 * The fence is an activity check, not an identity check. Identity comes from
 * the Durable Object binding the caller used to address this session; the
 * fence adds the second half: the request must name a turn of this session
 * that is running now, so a capability cannot be exercised outside a turn.
 *
 * One implementation, so every adapter-owned bridge agrees on what "live"
 * means without teaching the fence an adapter's headers or message ids.
 */
export function createHarnessOperationFence(
  options: HarnessOperationFenceOptions
): (request: Request) => boolean {
  return (request: Request) => {
    const operationId = options.operationId(request);
    if (!options.isHarnessSession() || !operationId) return false;
    if (options.messages.getProcessingMessage()?.id === operationId) return true;
    const controlRequestId = options.controlRequestId(operationId);
    return options.controls.isActiveOperation(controlRequestId ?? operationId);
  };
}
