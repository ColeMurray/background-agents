import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventTypeSchema,
  toolCallIdentityKey,
  type EventType,
  type SandboxEvent,
} from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import type { Logger } from "../../logger";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import { ArtifactRepository } from "../artifact-repository";
import { SessionBudgetService } from "../budget-service";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { SessionDiffService } from "../diffs/service";
import { EventRepository } from "../event-repository";
import { MessageRepository } from "../message-repository";
import { SandboxPushService } from "../sandbox-push-service";
import { SandboxRepository } from "../sandbox-repository";
import { initSchema } from "../schema";
import { SessionAttachmentRepository } from "../session-attachment-repository";
import { SessionCoreRepository } from "../session-core-repository";
import type { SessionStatusService } from "../session-status-service";
import { UsageRepository } from "../usage-repository";
import type { SessionWebSocketManager } from "../websocket-manager";
import { SandboxArtifactEventHandler } from "./artifact.handler";
import { SandboxExecutionEventHandler } from "./execution.handler";
import { SANDBOX_EVENT_PERSISTENCE } from "./persistence-inventory";
import { SessionSandboxEventProcessor } from "./processor";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import { SandboxStreamingEventHandler } from "./streaming.handler";

const SANDBOX_ID = "sb-1";
const MESSAGE_ID = "msg-1";
const GENERATION = { sandboxId: SANDBOX_ID, createdAt: 1 };

type EventOf<T extends EventType> = Extract<SandboxEvent, { type: T }>;

/**
 * Two events per type, sharing whatever identity the persistence mode keys on
 * (the message, the tool call), so an upsert collapses them and an append
 * keeps both. Keyed by the full union: a new event type needs an entry here
 * as well as in the inventory.
 */
const REPRESENTATIVE_EVENTS: { [T in EventType]: readonly [EventOf<T>, EventOf<T>] } = {
  heartbeat: [
    { type: "heartbeat", sandboxId: SANDBOX_ID, timestamp: 1 },
    { type: "heartbeat", sandboxId: SANDBOX_ID, timestamp: 2 },
  ],
  ready: [
    { type: "ready", sandboxId: SANDBOX_ID, timestamp: 1 },
    { type: "ready", sandboxId: SANDBOX_ID, timestamp: 2 },
  ],
  sandbox_generation_ready: [
    {
      type: "sandbox_generation_ready",
      sandboxId: SANDBOX_ID,
      timestamp: 1,
      generation: GENERATION,
    },
    {
      type: "sandbox_generation_ready",
      sandboxId: SANDBOX_ID,
      timestamp: 2,
      generation: GENERATION,
    },
  ],
  preservation_prepared: [
    {
      type: "preservation_prepared",
      sandboxId: SANDBOX_ID,
      timestamp: 1,
      operationId: "op-1",
      generation: GENERATION,
      executionStopped: true,
    },
    {
      type: "preservation_prepared",
      sandboxId: SANDBOX_ID,
      timestamp: 2,
      operationId: "op-1",
      generation: GENERATION,
      executionStopped: true,
    },
  ],
  token: [
    { type: "token", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 1, content: "Hel" },
    { type: "token", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 2, content: "Hello" },
  ],
  tool_call: [
    {
      type: "tool_call",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 1,
      tool: "bash",
      args: { command: "ls" },
      callId: "call-1",
      status: "running",
      output: "",
    },
    {
      type: "tool_call",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 2,
      tool: "bash",
      args: { command: "ls" },
      callId: "call-1",
      status: "completed",
      output: "README.md",
    },
  ],
  step_start: [
    {
      type: "step_start",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 1,
      stepId: "s1",
    },
    {
      type: "step_start",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 2,
      stepId: "s2",
    },
  ],
  step_finish: [
    {
      type: "step_finish",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 1,
      stepId: "s1",
      tokens: { input: 10, output: 2 },
    },
    {
      type: "step_finish",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 2,
      stepId: "s2",
      tokens: { input: 12, output: 3 },
    },
  ],
  tool_result: [
    {
      type: "tool_result",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 1,
      callId: "call-1",
      result: "partial",
    },
    {
      type: "tool_result",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 2,
      callId: "call-1",
      result: "final",
    },
  ],
  git_sync: [
    { type: "git_sync", sandboxId: SANDBOX_ID, timestamp: 1, status: "in_progress" },
    { type: "git_sync", sandboxId: SANDBOX_ID, timestamp: 2, status: "completed", sha: "abc123" },
  ],
  error: [
    { type: "error", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 1, error: "first" },
    { type: "error", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 2, error: "second" },
  ],
  execution_complete: [
    {
      type: "execution_complete",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 1,
      success: true,
    },
    {
      type: "execution_complete",
      sandboxId: SANDBOX_ID,
      messageId: MESSAGE_ID,
      timestamp: 2,
      success: false,
      error: "resent",
    },
  ],
  context_compacted: [
    { type: "context_compacted", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 1 },
    { type: "context_compacted", sandboxId: SANDBOX_ID, messageId: MESSAGE_ID, timestamp: 2 },
  ],
  artifact: [
    {
      type: "artifact",
      sandboxId: SANDBOX_ID,
      timestamp: 1,
      artifactType: "branch",
      url: "https://example.com/tree/one",
    },
    {
      type: "artifact",
      sandboxId: SANDBOX_ID,
      timestamp: 2,
      artifactType: "branch",
      url: "https://example.com/tree/two",
    },
  ],
  push_complete: [
    { type: "push_complete", sandboxId: SANDBOX_ID, timestamp: 1, branchName: "feature" },
    { type: "push_complete", sandboxId: SANDBOX_ID, timestamp: 2, branchName: "feature" },
  ],
  push_error: [
    { type: "push_error", sandboxId: SANDBOX_ID, timestamp: 1, branchName: "feature", error: "a" },
    { type: "push_error", sandboxId: SANDBOX_ID, timestamp: 2, branchName: "feature", error: "b" },
  ],
  warning: [
    { type: "warning", sandboxId: SANDBOX_ID, timestamp: 1, scope: "setup", message: "first" },
    { type: "warning", sandboxId: SANDBOX_ID, timestamp: 2, scope: "setup", message: "second" },
  ],
  boot_progress: [
    {
      type: "boot_progress",
      sandboxId: SANDBOX_ID,
      timestamp: 1,
      bootSeq: 1,
      phase: "sync",
      status: "started",
    },
    {
      type: "boot_progress",
      sandboxId: SANDBOX_ID,
      timestamp: 2,
      bootSeq: 2,
      phase: "sync",
      status: "completed",
    },
  ],
  session_title: [
    { type: "session_title", sandboxId: SANDBOX_ID, timestamp: 1, title: "First" },
    { type: "session_title", sandboxId: SANDBOX_ID, timestamp: 2, title: "Second" },
  ],
  snapshot_ready: [
    { type: "snapshot_ready", sandboxId: SANDBOX_ID, timestamp: 1, opencodeSessionId: "oc-1" },
    { type: "snapshot_ready", sandboxId: SANDBOX_ID, timestamp: 2, opencodeSessionId: "oc-1" },
  ],
  user_message: [
    { type: "user_message", messageId: MESSAGE_ID, timestamp: 1, content: "first" },
    { type: "user_message", messageId: MESSAGE_ID, timestamp: 2, content: "second" },
  ],
};

/** The row id `upsert_by_tool_call` keys on; null for any other event type. */
function toolCallRowId(event: SandboxEvent): string | null {
  return event.type === "tool_call" ? `tool_call:${toolCallIdentityKey(event)}` : null;
}

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

/**
 * The processor and its four family handlers as `components.ts` composes
 * them, over real repositories on node SQLite. Collaborators that never touch
 * session storage (broadcasts, callbacks, snapshot and queue triggers, the
 * graceful-shutdown coordinator with no shutdown in progress) are inert.
 */
function createStoredProcessor(db: DatabaseSync) {
  const storage = createNodeSqlStorage(db);
  initSchema(storage.sql);
  db.exec(
    "INSERT INTO session (id, model, harness, created_at, updated_at) VALUES ('s', 'model', 'opencode', 1, 1)"
  );
  db.exec("INSERT INTO participants (id, user_id, joined_at) VALUES ('p', 'user', 1)");
  db.exec(
    `INSERT INTO messages (id, author_id, content, source, status, created_at)
     VALUES ('${MESSAGE_ID}', 'p', 'prompt', 'web', 'processing', 1)`
  );
  db.exec(`INSERT INTO sandbox (id, status, created_at) VALUES ('${SANDBOX_ID}', 'connecting', 1)`);

  const { sql, transactionSync } = storage;
  const eventRepository = new EventRepository(sql, transactionSync);
  const usageRepository = new UsageRepository(sql, transactionSync);
  const messageRepository = new MessageRepository(
    sql,
    transactionSync,
    new SessionAttachmentRepository(sql),
    eventRepository
  );
  const sessionCoreRepository = new SessionCoreRepository(sql, transactionSync);
  const sandboxRepository = new SandboxRepository(sql, log, "unused-encryption-key");

  const messenger = { broadcast: () => {}, sendToSandbox: async () => {} };
  const wsManager = {
    getSandboxSocket: () => null,
    getSandboxCommandTarget: () => ({ kind: "unavailable" }),
    send: () => true,
  } as unknown as SessionWebSocketManager;
  const callbackService = {
    notifyToolCall: async () => {},
    notifyComplete: async () => {},
  } as unknown as CallbackNotificationService;
  const backgroundTasks = createTestBackgroundTasks();
  const updateLastActivity = () => {};
  const scheduleInactivityCheck = async () => {};
  const processMessageQueue = async () => {};

  const budgetService = new SessionBudgetService(
    sessionCoreRepository,
    messageRepository,
    eventRepository,
    messenger,
    { prepare: () => null, deliver: async () => {} },
    processMessageQueue,
    generateId
  );

  const processor = new SessionSandboxEventProcessor(
    log,
    messageRepository,
    wsManager,
    new SandboxStreamingEventHandler(
      backgroundTasks,
      eventRepository,
      callbackService,
      messenger,
      updateLastActivity,
      budgetService,
      usageRepository
    ),
    new SandboxArtifactEventHandler(
      new ArtifactRepository(sql),
      eventRepository,
      messenger,
      updateLastActivity
    ),
    new SandboxExecutionEventHandler(
      backgroundTasks,
      log,
      messageRepository,
      callbackService,
      messenger,
      async () => {},
      { reconcileAfterExecution: async () => {} } as unknown as SessionStatusService,
      async () => {},
      updateLastActivity,
      scheduleInactivityCheck,
      processMessageQueue,
      () => {},
      budgetService,
      transactionSync,
      () => {}
    ),
    new SandboxRuntimeEventHandler(
      sessionCoreRepository,
      sandboxRepository,
      eventRepository,
      messenger,
      { pinBaselines: () => {} } as unknown as SessionDiffService,
      (title) => ({ ok: true, title }),
      updateLastActivity,
      () => {},
      scheduleInactivityCheck,
      backgroundTasks,
      { processMessageQueue },
      log,
      { onRuntimeReady: () => false }
    ),
    new SandboxPushService(log, wsManager),
    { generationReady: () => {}, prepared: () => {} }
  );

  return {
    processor,
    events: () => eventRepository.getEventTimelinePage({ limit: 100 }).events,
    stepUsageRowCount: () => usageRepository.getSessionTotals().rowCount,
  };
}

describe("SANDBOX_EVENT_PERSISTENCE", () => {
  let db: DatabaseSync;
  let stored: ReturnType<typeof createStoredProcessor>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    stored = createStoredProcessor(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it.each(eventTypeSchema.options)("stores %s as its declared mode", async (type) => {
    const [first, second] = REPRESENTATIVE_EVENTS[type];
    await stored.processor.processSandboxEvent(first);
    await stored.processor.processSandboxEvent(second);
    const events = stored.events();
    const mode = SANDBOX_EVENT_PERSISTENCE[type];

    switch (mode) {
      case "append":
        expect(events.map((row) => row.type)).toEqual([type, type]);
        return;
      case "upsert_by_message":
        expect(events.map((row) => row.id)).toEqual([`${type}:${MESSAGE_ID}`]);
        return;
      case "upsert_by_tool_call":
        expect(events.map((row) => row.id)).toEqual([toolCallRowId(first)]);
        return;
      case "usage_table":
        expect(events).toEqual([]);
        expect(stored.stepUsageRowCount()).toBe(2);
        return;
      case "none":
        expect(events).toEqual([]);
        expect(stored.stepUsageRowCount()).toBe(0);
        return;
      default:
        mode satisfies never;
    }
  });

  it("keeps only the latest cumulative token text for a message", async () => {
    const [first, second] = REPRESENTATIVE_EVENTS.token;
    await stored.processor.processSandboxEvent(first);
    await stored.processor.processSandboxEvent(second);
    await stored.processor.processSandboxEvent({ ...first, messageId: "msg-2", content: "Other" });

    expect(stored.events().map((row) => [row.id, JSON.parse(row.data).content])).toEqual([
      [`token:${MESSAGE_ID}`, "Hello"],
      ["token:msg-2", "Other"],
    ]);
  });

  it("keeps the first execution completion for a message and drops a resend", async () => {
    const [completion, resend] = REPRESENTATIVE_EVENTS.execution_complete;
    await stored.processor.processSandboxEvent(completion);
    await stored.processor.processSandboxEvent(resend);

    expect(stored.events().map((row) => [row.id, JSON.parse(row.data).success])).toEqual([
      [`execution_complete:${MESSAGE_ID}`, true],
    ]);
  });

  it("keeps the pre-compaction token text when context is compacted", async () => {
    const [before, after] = REPRESENTATIVE_EVENTS.token;
    await stored.processor.processSandboxEvent(before);
    await stored.processor.processSandboxEvent(REPRESENTATIVE_EVENTS.context_compacted[0]);
    await stored.processor.processSandboxEvent(after);

    const events = stored.events();
    expect(events.map((row) => row.type)).toEqual(["token", "context_compacted", "token"]);
    expect(events[0].id).toMatch(new RegExp(`^token:${MESSAGE_ID}:`));
    expect(events.map((row) => JSON.parse(row.data).content)).toEqual(["Hel", undefined, "Hello"]);
  });

  it("keeps only the latest state of a tool call, at the first state's position", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [running, completed] = REPRESENTATIVE_EVENTS.tool_call;
    vi.setSystemTime(1_000);
    await stored.processor.processSandboxEvent(running);
    vi.setSystemTime(2_000);
    await stored.processor.processSandboxEvent(completed);

    const [row, ...rest] = stored.events();
    expect(rest).toEqual([]);
    expect(row.id).toBe(toolCallRowId(completed));
    expect(row.created_at).toBe(1_000);
    expect(JSON.parse(row.data)).toMatchObject({ status: "completed", output: "README.md" });
  });

  it("keeps a separate row per tool-call identity", async () => {
    const [call] = REPRESENTATIVE_EVENTS.tool_call;
    const subtaskCall = { ...call, isSubtask: true, childSessionId: "child-1" };
    await stored.processor.processSandboxEvent(call);
    await stored.processor.processSandboxEvent({ ...call, callId: "call-2" });
    await stored.processor.processSandboxEvent(subtaskCall);

    expect(stored.events().map((row) => row.id)).toEqual([
      toolCallRowId(call),
      toolCallRowId({ ...call, callId: "call-2" }),
      toolCallRowId(subtaskCall),
    ]);
  });
});
