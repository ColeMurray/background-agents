import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSession,
  initNamedSessionDO,
  initSession,
  openClientWs,
  queryDO,
  seedMessage,
  serviceFetch,
  waitForSandboxStatus,
} from "./helpers";
import type { PiRuntimeDispatch } from "../../src/pi/runtime-contract";

const BROWSER_USER_ID = "11111111111111111111111111111111";

describe("session budgets", () => {
  beforeEach(cleanD1Tables);

  it("charges a Pi terminal result exactly once and exhausts a tiny budget", async () => {
    const name = `budget-pi-terminal-${Date.now()}`;
    const { stub } = await initNamedSessionDO(name, {
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      sandboxSettings: { maxSessionCostUsd: 0.0001 },
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "pi-budget-message",
      authorId,
      content: "priced work",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 10,
      startedAt: Date.now() - 5,
    });
    const submit = () =>
      stub.fetch("http://internal/internal/pi-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "pi-budget-message",
          status: "done",
          text: "done",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
          costUsd: 0.0002,
        }),
      });

    expect((await submit()).status).toBe(200);
    await seedMessage(stub, {
      id: "pi-budget-message-b",
      authorId,
      content: "newer work",
      source: "web",
      status: "processing",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    expect(await (await submit()).json()).toEqual({ status: "already_projected" });
    expect(
      await queryDO<{
        total_cost: number;
        budget_exhausted: number;
        reported_cost_usd: number;
      }>(
        stub,
        `SELECT s.total_cost, s.budget_exhausted, m.reported_cost_usd
         FROM session s JOIN messages m ON m.id = 'pi-budget-message'`
      )
    ).toEqual([{ total_cost: 0.0002, budget_exhausted: 1, reported_cost_usd: 0.0002 }]);
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = 'pi-budget-message-b'"
      )
    ).toEqual([{ status: "processing" }]);
  });

  it("exactly aborts and settles a running Pi operation when a step crosses the cap", async () => {
    const abort = vi.fn(async () => true);
    const lookup = vi.fn<PiRuntimeDispatch["lookup"]>(async (_sessionId, operationId) => ({
      status: "settled",
      result: {
        operationId,
        status: "unanswered",
        text: "",
        reason: "aborted",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        costUsd: 0.0002,
      },
    }));
    const runtime = {
      initialize: vi.fn(async () => {}),
      submit: vi.fn(),
      lookup,
      abort,
      status: vi.fn(async () => ({ busy: true, pending: 1 })),
      control: vi.fn(),
      refreshDiff: vi.fn(async () => {}),
      preserveForArchive: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    } satisfies PiRuntimeDispatch;
    const { sessionName, stub } = await initSession({
      sessionName: `budget-pi-running-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
      sandboxSettings: { maxSessionCostUsd: 0.0001 },
      configureSessionEnv: (sessionEnv) => {
        sessionEnv.PI_SESSION = runtime;
      },
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "pi-running-budget-message",
      authorId,
      content: "keep working",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 10,
      startedAt: Date.now() - 5,
    });
    await queryDO(
      stub,
      `INSERT INTO pi_operation_dispatch
       (operation_id, state, last_projection_sequence, created_at, updated_at)
       VALUES ('pi-running-budget-message', 'admitted', 0, ?, ?)`,
      Date.now(),
      Date.now()
    );

    const projectionInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Operation-ID": "pi-running-budget-message",
        "X-Pi-Projection-ID": "pi-running-budget-message:step:1",
        "X-Pi-Projection-Sequence": "1",
      },
      body: JSON.stringify({
        type: "step_finish",
        sandboxId: `pi:${sessionName}`,
        timestamp: Date.now() / 1_000,
        messageId: "pi-running-budget-message",
        stepId: "pi-entry:1",
        cost: 0.0002,
        messageCostUsd: 0.0002,
        tokens: { input: 1, output: 1, total: 2 },
      }),
    } satisfies RequestInit;
    const response = await stub.fetch("http://internal/internal/pi-event", projectionInit);

    expect(response.status).toBe(200);
    expect(
      await (await stub.fetch("http://internal/internal/pi-event", projectionInit)).json()
    ).toEqual({ status: "already_projected" });
    await vi.waitFor(async () => {
      expect(abort).toHaveBeenCalledWith(sessionName, "pi-running-budget-message");
      expect(lookup).toHaveBeenCalledWith(sessionName, "pi-running-budget-message");
      expect(
        await queryDO<{ status: string; budget_exhausted: number; total_cost: number }>(
          stub,
          `SELECT m.status, s.budget_exhausted, s.total_cost FROM messages m JOIN session s
           WHERE m.id = 'pi-running-budget-message'`
        )
      ).toEqual([{ status: "failed", budget_exhausted: 1, total_cost: 0.0002 }]);
    });
  });

  it("lets the canonical owner manage a bot-created session from the browser", async () => {
    const name = `budget-bot-owner-${Date.now()}`;
    await initNamedSession(name, {
      userId: "slack:integration-actor",
      canonicalUserId: BROWSER_USER_ID,
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    const response = await serviceFetch(`https://test.local/sessions/${name}/budget`, {
      method: "PATCH",
      body: JSON.stringify({ maxCostUsd: 20 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    const { ws, messages } = await openClientWs(name, {
      subscribe: true,
      userId: BROWSER_USER_ID,
      canonicalUserId: BROWSER_USER_ID,
    });
    ws.close();
    expect(messages[0].canManageBudget).toBe(true);

    const member = await openClientWs(name, { subscribe: true, userId: "another-user" });
    member.ws.close();
    expect(member.messages[0].canManageBudget).toBe(false);
  });

  it("persists resolved budget settings in the session snapshot", async () => {
    const name = `budget-snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);
    const snapshot = await response.json<SessionSnapshot>();
    expect(snapshot.session).toMatchObject({
      totalCost: 0,
      maxSessionCostUsd: 10,
      budgetExhausted: false,
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

  it("delivers live budget status to a client subscribing without capabilities", async () => {
    const name = `budget-broadcast-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws } = await openClientWs(name, { subscribe: true });
    try {
      const updates = collectMessages(ws, { until: (message) => message.type === "budget_status" });
      const response = await stub.fetch("http://internal/internal/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxCostUsd: 20 }),
      });
      expect(response.status).toBe(200);
      expect(await updates).toContainEqual(
        expect.objectContaining({ type: "budget_status", maxSessionCostUsd: 20 })
      );
    } finally {
      ws.close();
    }
  });

  it("preserves live budget state when initialization is retried", async () => {
    const name = `budget-reinit-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    await queryDO(
      stub,
      `UPDATE session
       SET total_cost = 12, max_cost_usd = 15,
           budget_exhausted = 1`
    );
    await queryDO(
      stub,
      `UPDATE session_repositories SET branch_name = 'feature/live', current_sha = 'abc123'`
    );

    await initNamedSessionDO(name, { sandboxSettings: { maxSessionCostUsd: 100 } });

    expect(
      await queryDO(
        stub,
        `SELECT total_cost, max_cost_usd,
                budget_exhausted
         FROM session`
      )
    ).toEqual([
      {
        total_cost: 12,
        max_cost_usd: 15,
        budget_exhausted: 1,
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

  it("accepts unpriced steps without changing the budget or emitting warnings", async () => {
    const name = `budget-unpriced-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    const response = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "step_finish",
        messageId: "message-unpriced",
        cost: null,
        tokens: { total: 10, input: 8, output: 2 },
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);
    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 0, budget_exhausted: 0 },
    ]);
    expect(await queryDO(stub, "SELECT id FROM events WHERE type = 'warning'")).toEqual([]);
  });

  it("exhausts active work without an advance warning, preserves pending work, and clears on a raised limit", async () => {
    const name = `budget-enforcement-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
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

    const sendCost = (cost: number, messageCostUsd: number) =>
      stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "step_finish",
          messageId: "message-active",
          cost,
          messageCostUsd,
          tokens: { total: 10, input: 8, output: 2 },
          sandboxId: "sandbox-1",
          timestamp: Date.now(),
        }),
      });

    expect((await sendCost(7, 7)).status).toBe(200);
    // A resent report changes nothing.
    expect((await sendCost(7, 7)).status).toBe(200);
    expect(await queryDO(stub, "SELECT id FROM events WHERE type = 'warning'")).toEqual([]);
    expect((await sendCost(1, 8)).status).toBe(200);
    expect(await queryDO(stub, "SELECT id FROM events WHERE type = 'warning'")).toEqual([]);
    // The 9 report was lost; the next cumulative repairs it.
    expect((await sendCost(1, 10)).status).toBe(200);

    const [session] = await queryDO<{
      total_cost: number;
      budget_exhausted: number;
    }>(stub, "SELECT total_cost, budget_exhausted FROM session");
    expect(session).toEqual({ total_cost: 10, budget_exhausted: 1 });
    expect(
      await queryDO(stub, "SELECT reported_cost_usd FROM messages WHERE id = 'message-active'")
    ).toEqual([{ reported_cost_usd: 10 }]);
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
    expect(warningsBody.events.filter((item) => item.data.scope === "budget")).toHaveLength(1);

    const raised = await stub.fetch("http://internal/internal/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxCostUsd: 20 }),
    });
    expect(raised.status).toBe(200);
    expect(await queryDO(stub, "SELECT max_cost_usd, budget_exhausted FROM session")).toEqual([
      { max_cost_usd: 20, budget_exhausted: 0 },
    ]);
  });

  it("applies the final cumulative report carried on execution_complete", async () => {
    const name = `budget-final-${Date.now()}`;
    const { stub } = await initNamedSession(name, {
      sandboxSettings: { maxSessionCostUsd: 10 },
    });
    await waitForSandboxStatus(stub, "failed");
    const [{ id: ownerId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    await seedMessage(stub, {
      id: "message-final",
      authorId: ownerId,
      content: "Finishing work",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 100,
      startedAt: Date.now() - 50,
    });

    const response = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: "message-final",
        success: true,
        messageCostUsd: 3.25,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);
    expect(await queryDO(stub, "SELECT total_cost, budget_exhausted FROM session")).toEqual([
      { total_cost: 3.25, budget_exhausted: 0 },
    ]);
    expect(
      await queryDO(
        stub,
        "SELECT status, reported_cost_usd FROM messages WHERE id = 'message-final'"
      )
    ).toEqual([{ status: "completed", reported_cost_usd: 3.25 }]);
  });
});
