import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  initNamedSessionDO,
  queryDO,
  seedMessage,
  serviceFetch,
  waitForSandboxStatus,
} from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";

describe("session budgets", () => {
  beforeEach(cleanD1Tables);

  it("persists resolved budget settings in the session snapshot", async () => {
    const name = `budget-snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10, costWarningThresholdPct: 75 },
    });

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);
    const snapshot = await response.json<Record<string, any>>();
    expect(snapshot.session).toMatchObject({
      totalCost: 0,
      maxSessionCostUsd: 10,
      budgetExhausted: false,
      costTrackingUnavailable: false,
    });

    const rows = await queryDO<{ max_cost_usd: number | null }>(
      stub,
      "SELECT max_cost_usd FROM session"
    );
    expect(rows).toEqual([{ max_cost_usd: 10 }]);
  });

  it("allows the owner to change the live limit through the public route", async () => {
    const name = `budget-owner-${Date.now()}`;
    const { stub } = await initNamedSession(name, { canonicalUserId: BROWSER_USER_ID });

    const ownerResponse = await serviceFetch(`https://test.local/sessions/${name}/budget`, {
      method: "PATCH",
      body: JSON.stringify({ maxCostUsd: 20 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toMatchObject({ maxSessionCostUsd: 20 });

    const rows = await queryDO<{ max_cost_usd: number | null }>(
      stub,
      "SELECT max_cost_usd FROM session"
    );
    expect(rows).toEqual([{ max_cost_usd: 20 }]);
  });

  it("preserves live budget state when initialization is retried", async () => {
    const name = `budget-reinit-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    await queryDO(
      stub,
      `UPDATE session
       SET total_cost = 12, max_cost_usd = 15, cost_warning_sent = 1,
           budget_exhausted = 1, cost_tracking_unavailable = 1`
    );
    await queryDO(
      stub,
      `UPDATE session_repositories SET branch_name = 'feature/live', current_sha = 'abc123'`
    );

    await initNamedSessionDO(name, { sandboxSettings: { maxSessionCostUsd: 100 } });

    expect(
      await queryDO(
        stub,
        `SELECT total_cost, max_cost_usd, cost_warning_sent,
                budget_exhausted, cost_tracking_unavailable
         FROM session`
      )
    ).toEqual([
      {
        total_cost: 12,
        max_cost_usd: 15,
        cost_warning_sent: 1,
        budget_exhausted: 1,
        cost_tracking_unavailable: 1,
      },
    ]);
    expect(
      await queryDO(
        stub,
        `SELECT
           (SELECT COUNT(*) FROM participants) AS participant_count,
           (SELECT COUNT(*) FROM sandbox) AS sandbox_count,
           (SELECT branch_name FROM session_repositories LIMIT 1) AS branch_name,
           (SELECT current_sha FROM session_repositories LIMIT 1) AS current_sha`
      )
    ).toEqual([
      {
        participant_count: 1,
        sandbox_count: 1,
        branch_name: "feature/live",
        current_sha: "abc123",
      },
    ]);
  });

  it("latches unavailable cost tracking for a token-using unpriced step", async () => {
    const name = `budget-unpriced-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    const response = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "step_finish",
        ackId: "step_finish:null-cost",
        messageId: "message-unpriced",
        cost: null,
        tokens: { total: 10, input: 8, output: 2 },
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);
    expect(await queryDO(stub, "SELECT cost_tracking_unavailable FROM session")).toEqual([
      { cost_tracking_unavailable: 1 },
    ]);
  });

  it("warns, exhausts active work, preserves pending work, and clears on a raised limit", async () => {
    const name = `budget-enforcement-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10, costWarningThresholdPct: 80 },
    });
    await waitForSandboxStatus(stub, "failed");
    const [{ id: ownerId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    await seedMessage(stub, {
      id: "message-active",
      authorId: ownerId,
      content: "Active work",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 100,
      startedAt: Date.now() - 50,
    });
    await seedMessage(stub, {
      id: "message-pending",
      authorId: ownerId,
      content: "Pending work",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const sendCost = (cost: number, ackId: string) =>
      stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "step_finish",
          ackId,
          messageId: "message-active",
          cost,
          tokens: { total: 10, input: 8, output: 2 },
          sandboxId: "sandbox-1",
          timestamp: Date.now(),
        }),
      });

    expect((await sendCost(7, "step_finish:1")).status).toBe(200);
    expect((await sendCost(7, "step_finish:1")).status).toBe(200);
    expect(await queryDO(stub, "SELECT id FROM events WHERE type = 'warning'")).toEqual([]);
    expect((await sendCost(1, "step_finish:2")).status).toBe(200);
    expect((await sendCost(2, "step_finish:3")).status).toBe(200);

    const [session] = await queryDO<{
      total_cost: number;
      budget_exhausted: number;
      cost_warning_sent: number;
    }>(stub, "SELECT total_cost, budget_exhausted, cost_warning_sent FROM session");
    expect(session).toEqual({ total_cost: 10, budget_exhausted: 1, cost_warning_sent: 1 });
    expect(await queryDO(stub, "SELECT ack_id FROM step_finish_receipts ORDER BY ack_id")).toEqual([
      { ack_id: "step_finish:1" },
      { ack_id: "step_finish:2" },
      { ack_id: "step_finish:3" },
    ]);
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages ORDER BY created_at"
      )
    ).toEqual([
      { id: "message-active", status: "failed" },
      { id: "message-pending", status: "pending" },
    ]);
    const warningsResponse = await stub.fetch("http://internal/internal/events");
    const warningsBody = await warningsResponse.json<{
      events: Array<{ data: { scope?: string } }>;
    }>();
    expect(warningsBody.events.filter((item) => item.data.scope === "budget")).toHaveLength(2);

    const raised = await stub.fetch("http://internal/internal/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxCostUsd: 20 }),
    });
    expect(raised.status).toBe(200);
    expect(
      await queryDO(stub, "SELECT max_cost_usd, budget_exhausted, cost_warning_sent FROM session")
    ).toEqual([{ max_cost_usd: 20, budget_exhausted: 0, cost_warning_sent: 0 }]);
  });
});
