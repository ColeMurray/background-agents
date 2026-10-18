import type {
  McpConnectionBrokerDispatch,
  McpConnectionBrokerStatus,
} from "../mcp/broker-contract";
import type { McpConnectionDO } from "./mcp-connection-durable-object";

export function createMcpConnectionBrokerDispatch(
  namespace: DurableObjectNamespace<McpConnectionDO>
): McpConnectionBrokerDispatch {
  const stub = (connectionId: string) => namespace.get(namespace.idFromName(connectionId));
  return {
    initialize: (connectionId, ownerUserId) =>
      stub(connectionId).initialize(connectionId, ownerUserId),
    status: (connectionId): Promise<McpConnectionBrokerStatus> => stub(connectionId).status(),
    destroy: (connectionId) => stub(connectionId).destroy(connectionId),
  };
}
