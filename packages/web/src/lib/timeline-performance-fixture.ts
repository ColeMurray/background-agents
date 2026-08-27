import type { SandboxEvent } from "@/types/session";
import type { EventType } from "@open-inspect/shared/types/sandbox-events";

export const LARGE_SESSION_EVENT_COUNT = 100_000;

const SANDBOX_ID = "sandbox-performance-fixture";
const BASE_TIMESTAMP_SECONDS = 1_700_000_000;

interface EventContext {
  turn: number;
  messageId: string;
  timestamp: number;
}

type EventFactory = (context: EventContext) => SandboxEvent;

const EVENT_PATTERN: EventFactory[] = [
  ({ messageId, timestamp, turn }) => ({
    type: "user_message",
    content: `Review timeline rendering for deterministic turn ${turn}.`,
    messageId,
    timestamp,
    author: {
      participantId: "participant-performance",
      userId: "user-performance",
      name: "Performance Tester",
    },
  }),
  ({ messageId, timestamp }) => ({
    type: "step_start",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "token",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    content: `## Turn ${turn}\n\nInspecting the timeline fixture...`,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "tool_call",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    tool: "Read",
    args: { filePath: `/workspace/src/session-${turn % 12}.ts`, offset: 1, limit: 120 },
    callId: `read-${turn}`,
    status: "completed",
    output: `Read 120 lines from session-${turn % 12}.ts`,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "tool_result",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    callId: `read-${turn}`,
    result: `export const session${turn % 12} = { status: "ready" };`,
  }),
  ({ timestamp, turn }) => ({
    type: "warning",
    scope: turn % 2 === 0 ? "setup" : "media",
    message: `Optional fixture dependency ${turn % 5} was unavailable; continuing.`,
    repoOwner: "open-inspect",
    repoName: "background-agents",
    sandboxId: SANDBOX_ID,
    timestamp,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "token",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    content: `## Turn ${turn}\n\nInspecting the timeline fixture.\n\n- Read source\n- Checking output`,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "tool_call",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    tool: "Bash",
    args: { command: "npm test -- --run timeline", workdir: "/workspace/background-agents" },
    callId: `test-${turn}`,
    status: "completed",
    output: `Timeline checks passed for turn ${turn}`,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "tool_result",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    callId: `test-${turn}`,
    result: `PASS timeline fixture (${20 + (turn % 7)} tests)`,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "artifact",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    artifactType: "screenshot",
    artifactId: `artifact-${turn}`,
    url: `https://artifacts.example.test/timeline-${turn}.png`,
    metadata: { width: 1440, height: 900, label: `Timeline turn ${turn}` },
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "token",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    content: `## Turn ${turn} complete\n\nThe timeline output is stable.\n\n\`\`\`ts\nexpect(items.length).toBeGreaterThan(0);\n\`\`\``,
  }),
  ({ messageId, timestamp, turn }) => ({
    type: "step_finish",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    cost: 0.01 + (turn % 10) / 1_000,
    tokens: { input: 800 + (turn % 50), output: 240 + (turn % 30), cache: { read: 400 } },
    reason: "stop",
  }),
  ({ messageId, timestamp }) => ({
    type: "execution_complete",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
    success: true,
  }),
  ({ timestamp, turn }) => ({
    type: "heartbeat",
    sandboxId: SANDBOX_ID,
    timestamp,
    status: turn % 2 === 0 ? "running" : "idle",
  }),
  ({ timestamp, turn }) => ({
    type: "git_sync",
    sandboxId: SANDBOX_ID,
    timestamp,
    status: "completed",
    sha: turn.toString(16).padStart(40, "0"),
  }),
  ({ messageId, timestamp }) => ({
    type: "context_compacted",
    sandboxId: SANDBOX_ID,
    messageId,
    timestamp,
  }),
];

export interface TimelinePerformanceFixtureSummary {
  eventCount: number;
  byType: Partial<Record<EventType, number>>;
  approximateJsonBytes: number;
}

export function generateTimelinePerformanceFixture(
  eventCount = LARGE_SESSION_EVENT_COUNT
): SandboxEvent[] {
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) {
    throw new RangeError("eventCount must be a non-negative safe integer");
  }

  return Array.from({ length: eventCount }, (_, index) => {
    const turn = Math.floor(index / EVENT_PATTERN.length);
    return EVENT_PATTERN[index % EVENT_PATTERN.length]({
      turn,
      messageId: `message-${turn}`,
      timestamp: BASE_TIMESTAMP_SECONDS + index / 10,
    });
  });
}

export function summarizeTimelinePerformanceFixture(
  events: readonly SandboxEvent[]
): TimelinePerformanceFixtureSummary {
  const byType: Partial<Record<EventType, number>> = {};
  let approximateJsonBytes = 2;

  for (const [index, event] of events.entries()) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    approximateJsonBytes += JSON.stringify(event).length + (index === 0 ? 0 : 1);
  }

  return { eventCount: events.length, byType, approximateJsonBytes };
}
