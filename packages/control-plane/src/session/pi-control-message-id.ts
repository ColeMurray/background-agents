/**
 * The message id of a control-initiated turn.
 *
 * A control carries a request id, and the session records the turn it starts
 * as a message. The message's id is derived from the control's request id,
 * so the two can be told apart in either direction — and the *runtime* names
 * the message's id, because that is the id the session knows the turn by.
 */
export const PI_CONTROL_MESSAGE_ID_PREFIX = "pi-control:";

/** The message id of the turn a control starts. */
export function piControlMessageId(requestId: string): string {
  return `${PI_CONTROL_MESSAGE_ID_PREFIX}${requestId}`;
}

/**
 * The control's request id, from the message id of the turn it started.
 *
 * `null` when the message id is not a control's message — a prompt's message
 * id, for instance.
 */
export function piControlRequestIdFromMessageId(messageId: string): string | null {
  return messageId.startsWith(PI_CONTROL_MESSAGE_ID_PREFIX)
    ? messageId.slice(PI_CONTROL_MESSAGE_ID_PREFIX.length)
    : null;
}
