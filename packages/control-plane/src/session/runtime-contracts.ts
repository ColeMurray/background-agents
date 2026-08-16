export interface SessionRuntimeClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAt?: number;
}

export type SessionConnectionKind =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };
