import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";
import type { AgentEvent } from "@earendil-works/pi-durable";

/** Stable canonical timeline identity; immutable outbox sequence identifies each delivery version. */
export function piProjectionIdentity(
  operationId: string,
  event: SandboxIngressEvent,
  sourceIdentity?: string
): string {
  switch (event.type) {
    case "token":
      return `${operationId}:token:${event.partId ?? operationId}`;
    case "tool_call":
      return `${operationId}:tool:${event.callId}`;
    case "step_start":
    case "step_finish":
      return `${operationId}:${event.type}:${event.stepId}`;
    case "context_compacted":
      return `${operationId}:context_compacted:${sourceIdentity ?? "unknown"}`;
    default:
      return `${operationId}:${event.type}:${fingerprint(JSON.stringify(event))}`;
  }
}

export function piAgentEventIdentity(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "compaction_start":
    case "compaction_end":
    case "task_failed":
      return `${event.type}:${String(event.taskId)}`;
    case "message_end":
    case "entry_appended":
      return `${event.type}:${String(event.entry.id)}`;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return `${event.type}:${event.toolCallId}:${String(event.taskId ?? "unassigned")}`;
    default:
      return undefined;
  }
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
