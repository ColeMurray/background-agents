export const SESSION_READ_MAX_ATTEMPTS = 4;

interface TerminalMessageReadAttemptState {
  enabled: boolean;
  attemptsComplete: boolean;
  requestInFlight: boolean;
  attemptCount: number;
  intersecting: boolean;
  documentVisible: boolean;
  documentFocused: boolean;
}

export function shouldAttemptMarkMessageRead(state: TerminalMessageReadAttemptState): boolean {
  return (
    state.enabled &&
    !state.attemptsComplete &&
    !state.requestInFlight &&
    state.attemptCount < SESSION_READ_MAX_ATTEMPTS &&
    state.intersecting &&
    state.documentVisible &&
    state.documentFocused
  );
}
