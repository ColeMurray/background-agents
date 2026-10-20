import { beforeEach, expect, it } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

beforeEach(cleanD1Tables);

async function initCodexAccountingSession() {
  const { stub } = await initNamedSession(`codex-accounting-${crypto.randomUUID()}`, {
    harness: "codex",
    model: "openai/gpt-6.1-sol",
    sandboxSettings: { maxSessionCostUsd: 5 },
  });
  await waitForSandboxStatus(stub, "failed");
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
  return { stub, submit };
}

it("accepts message-less boot warnings and attributes delayed warnings to the original message", async () => {
  const { stub, submit } = await initCodexAccountingSession();
  await queryDO(stub, "UPDATE messages SET status = 'completed', completed_at = 4 WHERE id = 'm'");
  const bootResponse = await submit({
    type: "warning",
    scope: "setup",
    message: "Optional setup hook failed",
    messageId: undefined,
  });
  expect(bootResponse.status).toBe(200);

  const [participant] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  await seedMessage(stub, {
    id: "m-next",
    authorId: participant.id,
    content: "next task",
    source: "web",
    status: "processing",
    createdAt: 5,
    startedAt: 6,
  });
  const warning = {
    type: "warning",
    scope: "budget",
    message: "Codex API-equivalent cost is incomplete",
    messageId: "m",
    timestamp: 7,
  };
  expect((await submit(warning)).status).toBe(200);

  const warnings = await queryDO<{ message_id: string | null; data: string }>(
    stub,
    "SELECT message_id, data FROM events WHERE type = 'warning' ORDER BY timeline_sequence"
  );
  expect(warnings).toHaveLength(2);
  expect(warnings[0].message_id).toBeNull();
  expect(JSON.parse(warnings[0].data)).toMatchObject({ scope: "setup" });
  expect(JSON.parse(warnings[0].data)).not.toHaveProperty("messageId");
  expect(warnings[1].message_id).toBe("m");
  expect(JSON.parse(warnings[1].data)).toEqual({ sandboxId: "sb", ...warning });
});

it.each([
  { cost: 0, expectedCost: 0 },
  { cost: null, expectedCost: null },
  { cost: undefined, expectedCost: null },
])("preserves native step cost $cost as $expectedCost", async ({ cost, expectedCost }) => {
  const { stub, submit } = await initCodexAccountingSession();
  const step = {
    type: "step_finish",
    stepId: "native-step",
    cost,
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
    stepCostUsd: expectedCost,
    messageCostUsd: 0,
  });
  const snapshot = await (
    await stub.fetch("http://internal/internal/snapshot")
  ).json<SessionSnapshot>();
  expect(snapshot.session).toMatchObject({
    harness: "codex",
    totalCost: 0,
    budgetExhausted: false,
  });
});

it("persists native pricing corrections and accounts cumulative costs once through final budget repair", async () => {
  const { stub, submit } = await initCodexAccountingSession();
  const pricing = {
    source: "custom",
    model: "gpt-6.1-sol",
    rates: { input: 2, output: 10, cache_read: 0.2, tiers: [{ context: 200000, input: 4 }] },
  };
  const step = {
    type: "step_finish",
    stepId: "native-step",
    cost: 1.25,
    messageCostUsd: 1.25,
    tokens: { input: 10, output: 2, total: 12 },
    pricing,
  };
  for (const event of [step, step, { ...step, cost: 0.5, messageCostUsd: 0.5 }]) {
    expect((await submit(event)).status).toBe(200);
    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 1.25, budget_exhausted: 0 },
    ]);
    expect(await queryDO(stub, "SELECT reported_cost_usd FROM messages WHERE id = 'm'")).toEqual([
      { reported_cost_usd: 1.25 },
    ]);
  }
  const correctedPricing = { ...pricing, rates: { ...pricing.rates, input: 3 } };
  const correction = {
    ...step,
    cost: 2.5,
    messageCostUsd: 2.5,
    tokens: { input: 20, output: 4, total: 24 },
    pricing: correctedPricing,
  };
  expect((await submit(correction)).status).toBe(200);
  expect((await submit(correction)).status).toBe(200);
  expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
    { total_cost: 2.5, budget_exhausted: 0 },
  ]);

  // A missing step report is repaired by the final cumulative total, crossing the limit.
  for (const messageCostUsd of [5.5, 5.5, 3]) {
    expect(
      (await submit({ type: "execution_complete", success: true, messageCostUsd })).status
    ).toBe(200);
    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 5.5, budget_exhausted: 1 },
    ]);
    expect(await queryDO(stub, "SELECT reported_cost_usd FROM messages WHERE id = 'm'")).toEqual([
      { reported_cost_usd: 5.5 },
    ]);
  }
  expect(await queryDO(stub, "SELECT id FROM events WHERE type = 'warning'")).toHaveLength(1);
  const traceResponse = await stub.fetch("http://internal/internal/trace-export?include=usage");
  expect(traceResponse.status).toBe(200);
  const { trace } = await traceResponse.json<{ trace: { usage: Record<string, unknown>[] } }>();
  expect(trace.usage).toEqual([
    expect.objectContaining({
      id: "native-step",
      harness: "codex",
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
      stepCostUsd: 2.5,
      messageCostUsd: 2.5,
      pricing: correctedPricing,
    }),
  ]);
  const snapshot = await (
    await stub.fetch("http://internal/internal/snapshot")
  ).json<SessionSnapshot>();
  expect(snapshot.session).toMatchObject({
    harness: "codex",
    totalCost: 5.5,
    maxSessionCostUsd: 5,
    budgetExhausted: true,
  });
});
