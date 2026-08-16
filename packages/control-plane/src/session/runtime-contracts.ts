export interface SessionRuntimeClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

export type SessionConnectionKind =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };
