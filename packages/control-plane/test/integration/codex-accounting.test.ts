import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { initNamedSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

async function initCodexSession() {
  const { stub } = await initNamedSession(`codex-accounting-${crypto.randomUUID()}`, {
    harness: "codex",
    model: "openai/gpt-6.1-sol",
    sandboxSettings: { maxSessionCostUsd: 5 },
  });
  // Let the spawn attempt settle so a budget stop cannot race it.
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
  const traceUsage = async () => {
    const response = await stub.fetch("http://internal/internal/trace-export?include=usage");
    expect(response.status).toBe(200);
    const { trace } = await response.json<{ trace: { usage: Record<string, unknown>[] } }>();
    return trace;
  };
  const snapshot = async () =>
    (await stub.fetch("http://internal/internal/snapshot")).json<SessionSnapshot>();
  return { stub, submit, traceUsage, snapshot };
}

describe("codex accounting", () => {
  it("records a priced turn once without extra accounting metadata", async () => {
    const { stub, submit, traceUsage, snapshot } = await initCodexSession();
    const step = {
      type: "step_finish",
      stepId: "native-step",
      cost: 1.25,
      messageCostUsd: 1.25,
      tokens: { input: 10, output: 2, reasoning: 1, total: 12 },
    };
    expect((await submit(step)).status).toBe(200);
    expect((await submit(step)).status).toBe(200);
    expect(
      (await submit({ type: "execution_complete", success: true, messageCostUsd: 1.25 })).status
    ).toBe(200);

    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 1.25, budget_exhausted: 0 },
    ]);
    const trace = await traceUsage();
    expect(trace.usage).toHaveLength(1);
    expect(trace.usage[0]).toMatchObject({
      harness: "codex",
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 1,
      totalTokens: 12,
      stepCostUsd: 1.25,
      messageCostUsd: 1.25,
    });
    expect(trace).not.toHaveProperty("costBasis");
    expect(trace.usage[0]).not.toHaveProperty("pricingVersion");
    const { session } = await snapshot();
    expect(session).toMatchObject({ harness: "codex", totalCost: 1.25, budgetExhausted: false });
    expect(session).not.toHaveProperty("costAvailability");
  });

  it("exhausts the spend limit from a cumulative priced report", async () => {
    const { stub, submit, snapshot } = await initCodexSession();
    // Codex re-sends its single step with the turn's cumulative cost after each request.
    const step = (cost: number) =>
      submit({ type: "step_finish", stepId: "native-step", cost, messageCostUsd: cost });

    expect((await step(1.25)).status).toBe(200);
    expect((await step(5.5)).status).toBe(200);

    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 5.5, budget_exhausted: 1 },
    ]);
    expect((await snapshot()).session).toMatchObject({ totalCost: 5.5, budgetExhausted: true });
  });

  it("records an unpriced turn with a null step cost", async () => {
    const { stub, submit, traceUsage } = await initCodexSession();
    expect(
      (
        await submit({
          type: "step_finish",
          stepId: "native-step",
          messageCostUsd: 0,
          tokens: { input: 10, output: 2, total: 12 },
        })
      ).status
    ).toBe(200);

    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 0, budget_exhausted: 0 },
    ]);
    const trace = await traceUsage();
    expect(trace.usage).toHaveLength(1);
    expect(trace.usage[0]).toMatchObject({
      harness: "codex",
      inputTokens: 10,
      stepCostUsd: null,
      messageCostUsd: 0,
    });
  });
});
