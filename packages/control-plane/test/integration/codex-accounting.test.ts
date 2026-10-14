import { expect, it } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { initNamedSession, queryDO, seedMessage } from "./helpers";

it("round-trips native token usage and numeric zero cost without extra accounting metadata", async () => {
  const { stub } = await initNamedSession(`codex-accounting-${crypto.randomUUID()}`, {
    harness: "codex",
    model: "openai/gpt-6.1-sol",
    sandboxSettings: { maxSessionCostUsd: 5 },
  });
  const [participant] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  await seedMessage(stub, {
    id: "m",
    authorId: participant.id,
    content: "work",
    source: "web",
    status: "processing",
    createdAt: 1,
    startedAt: 2,
  });
  const submit = (event: Record<string, unknown>) =>
    stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId: "sb", messageId: "m", timestamp: 3, ...event }),
    });
  const step = {
    type: "step_finish",
    stepId: "native-step",
    cost: 0,
    messageCostUsd: 0,
    tokens: { input: 10, output: 2, total: 12 },
  };
  expect((await submit(step)).status).toBe(200);
  expect((await submit(step)).status).toBe(200);
  expect(
    (await submit({ type: "execution_complete", success: true, messageCostUsd: 0 })).status
  ).toBe(200);
  expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
    { total_cost: 0, budget_exhausted: 0 },
  ]);
  const traceResponse = await stub.fetch("http://internal/internal/trace-export?include=usage");
  expect(traceResponse.status).toBe(200);
  const { trace } = await traceResponse.json<{ trace: { usage: Record<string, unknown>[] } }>();
  expect(trace.usage).toHaveLength(1);
  expect(trace.usage[0]).toMatchObject({
    harness: "codex",
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    stepCostUsd: 0,
    messageCostUsd: 0,
  });
  expect(trace).not.toHaveProperty("costBasis");
  expect(trace.usage[0]).not.toHaveProperty("pricingVersion");
  const snapshot = await (
    await stub.fetch("http://internal/internal/snapshot")
  ).json<SessionSnapshot>();
  expect(snapshot.session).toMatchObject({
    harness: "codex",
    totalCost: 0,
    budgetExhausted: false,
  });
  expect(snapshot.session).not.toHaveProperty("costAvailability");
});
