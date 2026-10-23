import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../../../node/sqlite-storage";
import { initSchema } from "../../schema";
import { PiControlRepository } from "../../pi-control-repository";
import { PiControlHandler } from "./pi-control.handler";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function fixture(overrides: Record<string, unknown> = {}) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = createNodeSqlStorage(database);
  initSchema(storage.sql);
  const runtime = {
    control: vi.fn(async (input) => ({
      requestId: input.requestId,
      state: "accepted" as const,
      result: { submissionId: 1 },
    })),
    abort: vi.fn(async () => true),
  };
  const session = {
    id: "session-1",
    session_name: "session-1",
    harness: "pi",
    status: "active",
    budget_exhausted: 0,
    max_cost_usd: null,
    ...overrides,
  };
  const addSessionCost = vi.fn(() => 0.25);
  const setSessionBudget = vi.fn();
  const receipts = new PiControlRepository(storage.sql);
  const recordHumanControl = vi.fn();
  const enqueueModelControl = vi.fn(async () => ({
    messageId: "pi-control:request-1",
    deduplicated: false,
  }));
  const recordTerminal = vi.fn();
  const operations = { begin: vi.fn(), transition: vi.fn(), get: vi.fn(() => null) };
  const handler = new PiControlHandler(
    {
      getSession: () => session,
      addSessionCost,
      setSessionBudget,
      transaction: <T>(callback: () => T) => callback(),
    } as never,
    receipts,
    runtime,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
    recordHumanControl,
    enqueueModelControl,
    recordTerminal,
    operations
  );
  return {
    handler,
    runtime,
    receipts,
    addSessionCost,
    setSessionBudget,
    recordHumanControl,
    enqueueModelControl,
    recordTerminal,
    operations,
  };
}
function request(requestId = "request-1") {
  return new Request("http://session/internal/pi-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actorId: "user-1",
      canonicalUserId: "canonical-user-1",
      source: "web",
      control: { sessionId: "session-1", requestId, action: "reset" },
    }),
  });
}
describe("PiControlHandler", () => {
  it("executes once and replays a duplicate receipt", async () => {
    const h = fixture();
    expect((await h.handler.handle(request())).status).toBe(202);
    expect((await h.handler.handle(request())).status).toBe(202);
    expect(h.runtime.control).toHaveBeenCalledOnce();
  });
  it("re-reads a duplicate receipt when completion races message projection", async () => {
    const h = fixture();
    expect((await h.handler.handle(request())).status).toBe(202);
    h.recordHumanControl.mockImplementationOnce(() => {
      h.receipts.complete("request-1", "completed", undefined, Date.now());
      return { conflict: false, deduplicated: true };
    });

    const replay = await h.handler.handle(request());

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ state: "completed" });
    expect(h.runtime.control).toHaveBeenCalledOnce();
  });
  it("fails mutation controls closed for archived and exhausted sessions", async () => {
    expect((await fixture({ status: "archived" }).handler.handle(request())).status).toBe(409);
    expect((await fixture({ budget_exhausted: 1 }).handler.handle(request())).status).toBe(409);
  });
  it("marks an unavailable mutation outcome indeterminate without replay", async () => {
    const h = fixture();
    h.runtime.control.mockRejectedValueOnce(new Error("response lost"));
    expect((await h.handler.handle(request())).status).toBe(503);
    const replay = await h.handler.handle(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ state: "indeterminate" });
    expect(h.runtime.control).toHaveBeenCalledOnce();
  });
  it("rejects session identity and request payload drift", async () => {
    const h = fixture();
    const mismatched = new Request("http://session/internal/pi-control", {
      method: "POST",
      body: JSON.stringify({
        actorId: "user-1",
        canonicalUserId: "canonical-user-1",
        source: "web",
        control: { sessionId: "other", requestId: "request-1", action: "follow_up", content: "x" },
      }),
    });
    expect((await h.handler.handle(mismatched)).status).toBe(409);
    expect((await h.handler.handle(request())).status).toBe(202);
    const changed = new Request("http://session/internal/pi-control", {
      method: "POST",
      body: JSON.stringify({
        actorId: "user-1",
        source: "web",
        control: {
          sessionId: "session-1",
          requestId: "request-1",
          action: "follow_up",
          content: "different",
        },
      }),
    });
    expect((await h.handler.handle(changed)).status).toBe(409);
  });
  it("terminalizes callbacks and leaves cost to canonical event ingestion", async () => {
    const h = fixture({ max_cost_usd: 0.2 });
    expect((await h.handler.handle(request())).status).toBe(202);
    const completion = () =>
      new Request("http://session/internal/pi-control-completion", {
        method: "POST",
        body: JSON.stringify({ requestId: "request-1", status: "completed", costUsd: 0.25 }),
      });
    await expect((await h.handler.complete(completion())).json()).resolves.toEqual({
      status: "recorded",
    });
    await expect((await h.handler.complete(completion())).json()).resolves.toEqual({
      status: "already_recorded",
    });
    expect(h.addSessionCost).not.toHaveBeenCalled();
    expect(h.setSessionBudget).not.toHaveBeenCalled();
    expect(h.receipts.get("request-1")?.state).toBe("completed");
  });
  it("records a projected control turn's terminal event when its completion arrives", async () => {
    const h = fixture();
    h.recordHumanControl.mockReturnValue({
      conflict: false,
      deduplicated: false,
      messageId: "pi-control:request-1",
    });
    expect((await h.handler.handle(request())).status).toBe(202);
    expect(h.receipts.get("request-1")?.operationId).toBe("pi-control:request-1");

    const completion = (status: "completed" | "failed", errorCode?: string) =>
      new Request("http://session/internal/pi-control-completion", {
        method: "POST",
        body: JSON.stringify({ requestId: "request-1", status, errorCode, costUsd: 0.25 }),
      });
    await h.handler.complete(completion("completed"));
    await h.handler.complete(completion("failed", "model_error"));

    // The runtime may retry its completion; the terminal write is an upsert,
    // so every delivery carries the same identity and the last state wins.
    expect(h.recordTerminal).toHaveBeenCalledTimes(2);
    expect(h.recordTerminal).toHaveBeenLastCalledWith({
      operationId: "pi-control:request-1",
      success: false,
      error: "model_error",
      costUsd: 0.25,
      now: expect.any(Number),
    });
  });

  it("recovers a queued control completion when restart interrupted operation linking", async () => {
    const h = fixture();
    h.receipts.admit(
      {
        requestId: "restart-gap",
        requestHash: "a".repeat(64),
        action: "compact",
        actorId: "user-1",
        source: "web",
      },
      Date.now()
    );

    const response = await h.handler.complete(
      new Request("http://session/internal/pi-control-completion", {
        method: "POST",
        body: JSON.stringify({
          requestId: "pi-control:restart-gap",
          status: "completed",
          costUsd: 0,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "pi-control:restart-gap", success: true })
    );
  });

  it("projects human controls with verified actor metadata but not internal Pi controls", async () => {
    const human = fixture();
    expect((await human.handler.handle(request("human-control"))).status).toBe(202);
    expect(human.recordHumanControl).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        source: "web",
        requestId: "human-control",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        control: expect.objectContaining({ action: "reset" }),
      })
    );

    const internal = fixture();
    const internalRequest = new Request("http://session/internal/pi-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorId: "pi:operation-1",
        source: "pi",
        control: {
          sessionId: "session-1",
          requestId: "internal-control",
          action: "follow_up",
          content: "focus",
        },
      }),
    });
    expect((await internal.handler.handle(internalRequest)).status).toBe(202);
    expect(internal.recordHumanControl).not.toHaveBeenCalled();
  });

  it("queues manual compaction through the canonical message queue instead of dispatching it directly", async () => {
    const h = fixture();
    const compact = new Request("http://session/internal/pi-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorId: "user-1",
        canonicalUserId: "canonical-user-1",
        source: "web",
        control: {
          sessionId: "session-1",
          requestId: "compact-queued",
          action: "compact",
          conversationId: 1,
          instructions: "retain decisions",
        },
      }),
    });

    const response = await h.handler.handle(compact);

    expect(response.status).toBe(202);
    expect(h.enqueueModelControl).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "compact-queued",
        control: expect.objectContaining({ action: "compact", instructions: "retain decisions" }),
      })
    );
    expect(h.runtime.control).not.toHaveBeenCalled();
  });
  it("does not re-execute a human control after its bounded receipt was pruned", async () => {
    const h = fixture();
    h.recordHumanControl.mockReturnValue({ conflict: false, deduplicated: true });
    const response = await h.handler.handle(request("expired-control"));
    expect(response.status).toBe(409);
    expect(h.runtime.control).not.toHaveBeenCalled();
    expect(h.receipts.get("expired-control")?.state).toBe("failed");
  });
  it("rejects receipt conflicts before projecting a canonical message", async () => {
    const h = fixture();
    expect((await h.handler.handle(request("reused-control"))).status).toBe(202);
    h.recordHumanControl.mockClear();

    const response = await h.handler.handle(
      new Request("http://session/internal/pi-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          canonicalUserId: "user-1",
          source: "web",
          control: {
            sessionId: "session-1",
            requestId: "reused-control",
            action: "follow_up",
            content: "different content",
          },
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(h.recordHumanControl).not.toHaveBeenCalled();
    expect(h.runtime.control).toHaveBeenCalledOnce();
  });
});
