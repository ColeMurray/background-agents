import type { SandboxEvent } from "@/types/session";
import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";

export type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

export type FlatTimelineItem =
  | { type: "tool_group"; events: ToolCallEvent[]; id: string }
  | { type: "single"; event: SandboxEvent; id: string };

export type TimelineItem =
  | FlatTimelineItem
  | { type: "task_group"; event: ToolCallEvent; activity: FlatTimelineItem[]; id: string };

export type SessionTimelineItem =
  | TimelineItem
  | {
      type: "work_group";
      messageId: string;
      durationMs: number;
      activity: TimelineItem[];
      id: string;
    };

const directTimelineEventEligibility = {
  user_message: (event: SandboxEvent) =>
    event.type === "user_message" && Boolean(event.content || event.attachments?.length),
  token: (event: SandboxEvent) => event.type === "token" && Boolean(event.content),
  tool_result: (event: SandboxEvent) => event.type === "tool_result" && Boolean(event.error),
  git_sync: () => true,
  artifact: (event: SandboxEvent) =>
    event.type === "artifact" &&
    (event.artifactType === "screenshot" || event.artifactType === "video") &&
    Boolean(event.artifactId),
  error: () => true,
  warning: () => true,
  execution_complete: () => true,
  context_compacted: () => true,
} satisfies Partial<Record<SandboxEvent["type"], (event: SandboxEvent) => boolean>>;

export type DirectTimelineEventType = keyof typeof directTimelineEventEligibility;
export type RenderableTimelineEvent =
  | Extract<SandboxEvent, { type: Exclude<DirectTimelineEventType, "artifact"> }>
  | (Extract<SandboxEvent, { type: "artifact" }> & {
      artifactId: string;
      artifactType: "screenshot" | "video";
    });

const NO_PENDING_MESSAGES: ReadonlySet<string> = new Set();

export function isRenderableTimelineEvent(
  event: SandboxEvent,
  pendingMessageIds: ReadonlySet<string> = NO_PENDING_MESSAGES
): event is RenderableTimelineEvent | ToolCallEvent {
  if (event.type === "tool_call") return true;
  if (event.type === "user_message" && event.messageId && pendingMessageIds.has(event.messageId)) {
    return false;
  }
  const eligibility = directTimelineEventEligibility[event.type as DirectTimelineEventType];
  return eligibility?.(event) ?? false;
}

export function toolCallKey(event: ToolCallEvent): string {
  return toolCallIdentityKey(event);
}

function taskKey(messageId: string, callId: string): string {
  return `${messageId}:${callId}`;
}

function eventKey(event: SandboxEvent): string {
  if (event.type === "tool_call") return `tool:${toolCallKey(event)}`;
  const messageId = "messageId" in event ? event.messageId : undefined;
  const sandboxId = "sandboxId" in event ? event.sandboxId : undefined;
  return `${event.type}:${messageId || sandboxId || "session"}:${event.timestamp}`;
}

function groupFlatEvents(events: SandboxEvent[]): FlatTimelineItem[] {
  const groups: FlatTimelineItem[] = [];
  let tools: ToolCallEvent[] = [];

  const flushTools = () => {
    if (tools.length === 0) return;
    groups.push({
      type: "tool_group",
      events: tools,
      id: `tools:${eventKey(tools[tools.length - 1])}`,
    });
    tools = [];
  };

  for (const event of events) {
    if (event.type === "tool_call") {
      if (tools.length === 0 || tools[0].tool.toLowerCase() === event.tool.toLowerCase()) {
        tools.push(event);
      } else {
        flushTools();
        tools = [event];
      }
      continue;
    }

    flushTools();
    groups.push({ type: "single", event, id: eventKey(event) });
  }

  flushTools();
  return groups;
}

function dedupeEvents(events: SandboxEvent[]): SandboxEvent[] {
  const result: Array<SandboxEvent | null> = [];
  const toolIndexes = new Map<string, number>();
  const completionMessageIds = new Set<string>();
  const tokenIndexes = new Map<string, number>();

  for (const event of events) {
    if (event.type === "tool_call" && event.callId) {
      const key = toolCallKey(event);
      const index = toolIndexes.get(key);
      if (index === undefined) {
        toolIndexes.set(key, result.length);
        result.push(event);
      } else {
        result[index] = event;
      }
    } else if (event.type === "execution_complete" && event.messageId) {
      if (!completionMessageIds.has(event.messageId)) {
        completionMessageIds.add(event.messageId);
        result.push(event);
      }
    } else if (event.type === "token" && event.messageId) {
      const index = tokenIndexes.get(event.messageId);
      if (index !== undefined) result[index] = null;
      tokenIndexes.set(event.messageId, result.length);
      result.push(event);
    } else {
      if (event.type === "context_compacted") tokenIndexes.delete(event.messageId);
      result.push(event);
    }
  }

  return result.filter((event): event is SandboxEvent => event !== null);
}

export function buildTimelineItems(events: SandboxEvent[]): TimelineItem[] {
  const deduped = dedupeEvents(events);
  const tasks = new Map<string, ToolCallEvent>();

  for (const event of deduped) {
    if (event.type === "tool_call" && event.tool.toLowerCase() === "task") {
      tasks.set(taskKey(event.messageId, event.callId), event);
    }
  }

  const activityByTask = new Map<string, SandboxEvent[]>();
  const nestedEvents = new Set<SandboxEvent>();
  for (const event of deduped) {
    if (!("isSubtask" in event) || !event.isSubtask || !("taskCallId" in event)) continue;
    if (!event.taskCallId) continue;

    const key = taskKey(event.messageId, event.taskCallId);
    if (!tasks.has(key)) continue;
    nestedEvents.add(event);
    if (event.type === "step_start" || event.type === "step_finish") continue;
    const activity = activityByTask.get(key) ?? [];
    activity.push(event);
    activityByTask.set(key, activity);
  }

  const items: TimelineItem[] = [];
  let flatEvents: SandboxEvent[] = [];
  const flushFlatEvents = () => {
    items.push(...groupFlatEvents(flatEvents));
    flatEvents = [];
  };

  for (const event of deduped) {
    if (nestedEvents.has(event)) continue;
    if (event.type === "tool_call" && event.tool.toLowerCase() === "task") {
      const key = taskKey(event.messageId, event.callId);
      flushFlatEvents();
      items.push({
        type: "task_group",
        event,
        activity: groupFlatEvents(activityByTask.get(key) ?? []),
        id: `task:${key}`,
      });
      continue;
    }
    flatEvents.push(event);
  }

  flushFlatEvents();
  return items;
}

/**
 * Collapses completed turn activity while leaving in-flight and partial-history
 * events in their existing flat presentation.
 */
export function buildSessionTimelineItems(
  events: SandboxEvent[],
  pendingMessageIds: ReadonlySet<string> = NO_PENDING_MESSAGES
): SessionTimelineItem[] {
  const items = buildTimelineItems(
    events.filter((event) => isRenderableTimelineEvent(event, pendingMessageIds))
  );
  const result: SessionTimelineItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type !== "single" || item.event.type !== "user_message") {
      result.push(item);
      continue;
    }
    const userMessage = item.event;

    let completionIndex = index + 1;
    while (completionIndex < items.length) {
      const candidate = items[completionIndex];
      if (
        candidate.type === "single" &&
        (candidate.event.type === "user_message" || candidate.event.type === "execution_complete")
      ) {
        break;
      }
      completionIndex += 1;
    }
    const completion = items[completionIndex];
    if (
      completion?.type !== "single" ||
      completion.event.type !== "execution_complete" ||
      completion.event.messageId !== userMessage.messageId
    ) {
      result.push(item);
      continue;
    }

    let finalOutputIndex = -1;
    for (let candidateIndex = index + 1; candidateIndex < completionIndex; candidateIndex += 1) {
      const candidate = items[candidateIndex];
      if (
        candidate.type === "single" &&
        candidate.event.type === "token" &&
        candidate.event.messageId === userMessage.messageId
      ) {
        finalOutputIndex = candidateIndex;
      }
    }

    const activityEndIndex = finalOutputIndex >= 0 ? finalOutputIndex : completionIndex;
    const activity = items.slice(index + 1, activityEndIndex);
    result.push(item);
    result.push({
      type: "work_group",
      messageId: userMessage.messageId,
      durationMs: Math.max(0, completion.event.timestamp - userMessage.timestamp) * 1000,
      activity,
      id: `work:${userMessage.messageId}`,
    });

    for (
      let candidateIndex = activityEndIndex;
      candidateIndex <= completionIndex;
      candidateIndex += 1
    ) {
      result.push(items[candidateIndex]);
    }
    index = completionIndex;
  }

  return result;
}
