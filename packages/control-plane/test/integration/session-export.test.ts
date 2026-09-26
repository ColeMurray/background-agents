import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_INCLUDED_BYTES_PER_SESSION } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedEvents, seedMessage, serviceFetch } from "./helpers";

type ExportLine = Record<string, unknown>;

async function exportLines(include: string): Promise<ExportLine[]> {
  const response = await serviceFetch(`https://cp.test/sessions/export?include=${include}`);
  expect(response.status).toBe(200);
  return (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ExportLine);
}

async function postSandboxEvent(
  stub: DurableObjectStub,
  event: Record<string, unknown>
): Promise<void> {
  const response = await stub.fetch("http://internal/internal/sandbox-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandboxId: "sb-export", timestamp: Date.now() / 1000, ...event }),
  });
  expect(response.status).toBe(200);
}

/** Token events of `count` rows, each carrying `bytes` of text. */
function largeTokenEvents(prefix: string, count: number, bytes: number, createdAt: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: "token",
    data: JSON.stringify({ type: "token", messageId: "msg-1", content: "x".repeat(bytes) }),
    messageId: "msg-1",
    createdAt: createdAt + index,
  }));
}

describe("GET /sessions/export with include", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("exports the prompt, tool activity, step usage and outcome the session recorded", async () => {
    const { stub, sessionName } = await initSession({ title: "Run the tests" });
    const [owner] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    await seedMessage(stub, {
      id: "msg-1",
      authorId: owner.id,
      content: "Run the tests",
      source: "web",
      status: "processing",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    const toolCall = {
      type: "tool_call",
      messageId: "msg-1",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
    };
    await postSandboxEvent(stub, { ...toolCall, status: "running" });
    await postSandboxEvent(stub, {
      type: "step_finish",
      messageId: "msg-1",
      stepId: "step-1",
      cost: 0.01,
      tokens: { total: 1_500, input: 1_200, output: 300, cache: { read: 800 } },
      reason: "tool-calls",
    });
    await postSandboxEvent(stub, { ...toolCall, status: "completed", output: "1 passed" });
    await postSandboxEvent(stub, { type: "token", messageId: "msg-1", content: "Tests pass." });
    await postSandboxEvent(stub, {
      type: "step_finish",
      messageId: "msg-1",
      stepId: "step-2",
      cost: 0.02,
      tokens: { input: 1_600, output: 40 },
      reason: "stop",
    });
    await postSandboxEvent(stub, { type: "execution_complete", messageId: "msg-1", success: true });

    const lines = await exportLines("messages,events,usage");

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      schemaVersion: 1,
      type: "session",
      id: sessionName,
      title: "Run the tests",
      messages: [{ id: "msg-1", content: "Run the tests", status: "completed" }],
      events: [
        {
          type: "tool_call",
          messageId: "msg-1",
          data: { callId: "call-1", status: "completed", output: "1 passed" },
        },
        { id: "token:msg-1", type: "token", data: { content: "Tests pass." } },
        { id: "execution_complete:msg-1", type: "execution_complete", data: { success: true } },
      ],
      usage: [
        {
          id: "step-1",
          messageId: "msg-1",
          inputTokens: 1_200,
          outputTokens: 300,
          cacheReadTokens: 800,
          totalTokens: 1_500,
          stepCostUsd: 0.01,
          reason: "tool-calls",
        },
        {
          id: "step-2",
          messageId: "msg-1",
          inputTokens: 1_600,
          outputTokens: 40,
          cacheReadTokens: null,
          totalTokens: 1_640,
          stepCostUsd: 0.02,
          reason: "stop",
        },
      ],
    });
    const sequences = (line.events as Array<{ timelineSequence: number }>).map(
      (event) => event.timelineSequence
    );
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("exports a multi-megabyte trace and fails only the session over the byte budget", async () => {
    const rowBytes = 1024 * 1024;
    const withinBudget = await initSession({ title: "within budget" });
    await seedEvents(withinBudget.stub, largeTokenEvents("fits", 3, rowBytes, Date.now()));
    const overBudget = await initSession({ title: "over budget" });
    const rowsOverBudget = Math.ceil(MAX_INCLUDED_BYTES_PER_SESSION / rowBytes) + 1;
    await seedEvents(
      overBudget.stub,
      largeTokenEvents("spills", rowsOverBudget, rowBytes, Date.now())
    );

    const lines = await exportLines("events");

    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.sessionId === overBudget.sessionName)).toEqual({
      schemaVersion: 1,
      type: "session_error",
      sessionId: overBudget.sessionName,
      reason: "message_budget_exceeded",
    });
    const exported = lines.find((line) => line.id === withinBudget.sessionName);
    expect(exported).toMatchObject({ type: "session", title: "within budget" });
    expect((exported?.events as Array<{ id: string }>).map((event) => event.id)).toEqual([
      "fits-0",
      "fits-1",
      "fits-2",
    ]);
  });
});
