/** Mutable state associated with one authenticated browser connection. */
export interface SessionClientConnectionState {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

export type SessionConnectionKind =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };
