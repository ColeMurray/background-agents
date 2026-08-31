import {
  externalEventPageSchema,
  type ExternalEventPage,
} from "@open-inspect/shared/types/external-session-api";
import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { sessionEventChangePageSchema } from "../session/contracts";

interface SafeEventData {
  [key: string]: boolean | number | string | SafeEventData;
}

const SAFE_STATUSES = new Set([
  "pending",
  "in_progress",
  "running",
  "completed",
  "failed",
  "error",
  "ready",
  "stopped",
]);

function assertNever(value: never): never {
  throw new Error(`Unsupported event type: ${String(value)}`);
}

function numericUsage(
  event: Extract<SandboxEvent, { type: "step_finish" }>
): SafeEventData | number | undefined {
  if (typeof event.tokens === "number") return event.tokens;
  if (!event.tokens) return undefined;
  const cache: SafeEventData = {};
  if (typeof event.tokens.cache?.read === "number") cache.read = event.tokens.cache.read;
  if (typeof event.tokens.cache?.write === "number") cache.write = event.tokens.cache.write;
  const usage: SafeEventData = {};
  if (typeof event.tokens.total === "number") usage.total = event.tokens.total;
  if (typeof event.tokens.input === "number") usage.input = event.tokens.input;
  if (typeof event.tokens.output === "number") usage.output = event.tokens.output;
  if (typeof event.tokens.reasoning === "number") usage.reasoning = event.tokens.reasoning;
  if (Object.keys(cache).length) usage.cache = cache;
  return usage;
}

/** Projects only fixed enums, booleans, and numeric metadata. */
function safeEventData(event: SandboxEvent): SafeEventData {
  const data: SafeEventData = { type: event.type, timestamp: event.timestamp };
  switch (event.type) {
    case "git_sync":
      data.status = event.status;
      break;
    case "step_finish": {
      if (typeof event.cost === "number") data.cost = event.cost;
      const tokens = numericUsage(event);
      if (tokens !== undefined) data.tokens = tokens;
      if (event.isSubtask !== undefined) data.isSubtask = event.isSubtask;
      break;
    }
    case "step_start":
    case "error":
      if (event.isSubtask !== undefined) data.isSubtask = event.isSubtask;
      break;
    case "tool_call":
      if (event.status && SAFE_STATUSES.has(event.status)) data.status = event.status;
      if (event.isSubtask !== undefined) data.isSubtask = event.isSubtask;
      break;
    case "execution_complete":
      data.success = event.success;
      break;
    case "warning":
      data.scope = event.scope;
      break;
    case "heartbeat":
      if (SAFE_STATUSES.has(event.status)) data.status = event.status;
      break;
    case "ready":
    case "token":
    case "tool_result":
    case "context_compacted":
    case "artifact":
    case "push_complete":
    case "push_error":
    case "session_title":
    case "user_message":
      break;
    default:
      assertNever(event);
  }
  return data;
}

/** Parses internal events and emits an envelope safe without credential material. */
export function projectExternalEventPage(page: unknown): ExternalEventPage {
  const parsed = sessionEventChangePageSchema.parse(page);
  return externalEventPageSchema.parse({
    changes: parsed.changes.map((change) => {
      if (change.kind === "delete") return change;
      const data = sandboxEventSchema.parse(change.event.data);
      if (data.type !== change.event.type) {
        throw new Error("Event envelope type does not match event data");
      }
      return {
        kind: change.kind,
        revision: change.revision,
        event: {
          id: change.event.id,
          type: change.event.type,
          messageId: change.event.messageId,
          createdAt: change.event.createdAt,
          data: safeEventData(data),
        },
      };
    }),
    checkpoint: parsed.checkpoint,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    hasMore: parsed.hasMore,
  });
}
