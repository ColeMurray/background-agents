import { beforeEach, describe, expect, it } from "vitest";
import {
  eventTypeSchema,
  toolCallIdentityKey,
  type EventType,
  type SandboxEvent,
} from "@open-inspect/shared/types/sandbox-events";
import { SANDBOX_EVENT_PERSISTENCE } from "../../src/session/sandbox-events/persistence-inventory";
import { initSession, queryDO, seedMessage } from "./helpers";

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
      stepId: "s1",
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

interface EventRow {
  id: string;
  type: string;
  data: string;
  created_at: number;
}

interface StepUsageRow {
  id: string;
  input_tokens: number | null;
  created_at: number;
}

/**
 * A session Durable Object built by the production runtime, with one
 * processing message for events to attribute to. Events go through the same
 * `/internal/sandbox-event` route and processor the sandbox bridge feeds.
 */
async function createStoredSession() {
  const { stub } = await initSession();
  const [owner] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  await seedMessage(stub, {
    id: MESSAGE_ID,
    authorId: owner.id,
    content: "prompt",
    source: "web",
    status: "processing",
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
  const [{ baseline }] = await queryDO<{ baseline: number }>(
    stub,
    "SELECT COALESCE(MAX(timeline_sequence), 0) AS baseline FROM events"
  );

  return {
    async send(event: SandboxEvent): Promise<void> {
      const response = await stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      expect(response.status).toBe(200);
    },
    /** Timeline rows written since the session was set up, oldest first. */
    events: () =>
      queryDO<EventRow>(
        stub,
        `SELECT id, type, data, created_at FROM events
         WHERE timeline_sequence > ? ORDER BY timeline_sequence`,
        baseline
      ),
    stepUsage: () =>
      queryDO<StepUsageRow>(stub, "SELECT id, input_tokens, created_at FROM step_usage"),
  };
}

describe("SANDBOX_EVENT_PERSISTENCE", () => {
  let session: Awaited<ReturnType<typeof createStoredSession>>;

  beforeEach(async () => {
    session = await createStoredSession();
  });

  it.each(eventTypeSchema.options)("stores %s as its declared mode", async (type) => {
    const [first, second] = REPRESENTATIVE_EVENTS[type];
    await session.send(first);
    await session.send(second);
    const events = await session.events();
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
        expect(await session.stepUsage()).toHaveLength(1);
        return;
      case "none":
        expect(events).toEqual([]);
        expect(await session.stepUsage()).toEqual([]);
        return;
      default:
        mode satisfies never;
    }
  });

  it("keeps only the latest cumulative token text for a message", async () => {
    const [first, second] = REPRESENTATIVE_EVENTS.token;
    await session.send(first);
    await session.send(second);
    await session.send({ ...first, messageId: "msg-2", content: "Other" });

    const events = await session.events();
    expect(events.map((row) => [row.id, JSON.parse(row.data).content])).toEqual([
      [`token:${MESSAGE_ID}`, "Hello"],
      ["token:msg-2", "Other"],
    ]);
  });

  it("keeps the first execution completion for a message and drops a resend", async () => {
    const [completion, resend] = REPRESENTATIVE_EVENTS.execution_complete;
    await session.send(completion);
    await session.send(resend);

    const events = await session.events();
    expect(events.map((row) => [row.id, JSON.parse(row.data).success])).toEqual([
      [`execution_complete:${MESSAGE_ID}`, true],
    ]);
  });

  it("keeps the pre-compaction token text when context is compacted", async () => {
    const [before, after] = REPRESENTATIVE_EVENTS.token;
    await session.send(before);
    await session.send(REPRESENTATIVE_EVENTS.context_compacted[0]);
    await session.send(after);

    const events = await session.events();
    expect(events.map((row) => row.type)).toEqual(["token", "context_compacted", "token"]);
    expect(events[0].id).toMatch(new RegExp(`^token:${MESSAGE_ID}:`));
    expect(events.map((row) => JSON.parse(row.data).content)).toEqual(["Hel", undefined, "Hello"]);
  });

  it("keeps only the latest state of a tool call, at the first state's position", async () => {
    const [running, completed] = REPRESENTATIVE_EVENTS.tool_call;
    await session.send(running);
    const [runningRow] = await session.events();
    await session.send(completed);

    const [row, ...rest] = await session.events();
    expect(rest).toEqual([]);
    expect(row.id).toBe(toolCallRowId(completed));
    expect(row.created_at).toBe(runningRow.created_at);
    expect(JSON.parse(row.data)).toMatchObject({ status: "completed", output: "README.md" });
  });

  it("keeps a separate row per tool-call identity", async () => {
    const [call] = REPRESENTATIVE_EVENTS.tool_call;
    const subtaskCall = { ...call, isSubtask: true, childSessionId: "child-1" };
    await session.send(call);
    await session.send({ ...call, callId: "call-2" });
    await session.send(subtaskCall);

    const events = await session.events();
    expect(events.map((row) => row.id)).toEqual([
      toolCallRowId(call),
      toolCallRowId({ ...call, callId: "call-2" }),
      toolCallRowId(subtaskCall),
    ]);
  });

  it("replaces a resent step's usage in place, keeping its first arrival time", async () => {
    const [step, resend] = REPRESENTATIVE_EVENTS.step_finish;
    await session.send(step);
    const [firstRow] = await session.stepUsage();
    await session.send(resend);

    expect(await session.stepUsage()).toEqual([
      { id: "s1", input_tokens: 12, created_at: firstRow.created_at },
    ]);
  });
});
