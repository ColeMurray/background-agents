export interface McpConnectionBrokerStatus {
  enabled: false;
  connectionId: string;
  ownerUserId: string;
  transportCacheEntries: number;
  reason: string;
}

/** Binding-only control-plane port. No connect, callback, catalog, or tool invocation exists yet. */
export interface McpConnectionBrokerDispatch {
  initialize(connectionId: string, ownerUserId: string): Promise<void>;
  status(connectionId: string): Promise<McpConnectionBrokerStatus>;
  destroy(connectionId: string, ownerUserId: string): Promise<void>;
}
