/** Minimum client identity needed by platform-neutral protocol and lifecycle code. */
export interface SessionRuntimeClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

export type SessionConnectionKind =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };
