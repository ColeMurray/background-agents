import type {
  McpBrokerCall,
  McpBrokerCallResult,
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
    authorize: (connectionId, ownerUserId, options) =>
      stub(connectionId).authorize(connectionId, ownerUserId, options),
    // The explicit annotation keeps the Durable Object RPC types from being
    // instantiated through the whole request surface.
    callTool: (call: McpBrokerCall): Promise<McpBrokerCallResult> =>
      stub(call.connectionId).callTool(call),
    destroy: (connectionId, ownerUserId) => stub(connectionId).destroy(connectionId, ownerUserId),
    handleCallback: (connectionId, request) => stub(connectionId).handleCallback(request),
  };
}
