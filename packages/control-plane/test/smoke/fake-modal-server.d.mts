export interface FakeModalServer {
  origin: string;
  state: {
    createRequests: Array<{ sessionId: string; sandboxId: string }>;
    bridgeConnections: number;
    generationHandshakes: number;
    promptsReceived: Array<{ messageId: string; content: string }>;
    snapshots: number;
    rejectedTokens: number;
    preservations: number;
    restores: number;
    stops: number;
    unexpectedRequests: string[];
    errors: string[];
  };
  readonly activeBridges: number;
  holdTurns(): void;
  releaseTurns(): void;
  close(): Promise<void>;
}
export function startFakeModalServer(options: {
  port?: number;
  host?: string;
  secret: string;
  reply?: string;
  runtimeVersion?: string;
  heartbeatMs?: number;
  chunkDelayMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<FakeModalServer>;
