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
  const handler = new PiControlHandler(
    {
      getSession: () => session,
      addSessionCost,
      setSessionBudget,
      transaction: <T>(callback: () => T) => callback(),
    } as never,
    receipts,
    runtime,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
  );
  return { handler, runtime, receipts, addSessionCost, setSessionBudget };
}
function request(requestId = "request-1") {
  return new Request("http://session/internal/pi-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actorId: "user-1",
      source: "web",
      control: { sessionId: "session-1", requestId, action: "steer", content: "focus" },
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
        source: "web",
        control: { sessionId: "other", requestId: "request-1", action: "steer", content: "x" },
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
          action: "steer",
          content: "different",
        },
      }),
    });
    expect((await h.handler.handle(changed)).status).toBe(409);
  });
  it("terminalizes callbacks and applies their cost exactly once", async () => {
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
    expect(h.addSessionCost).toHaveBeenCalledOnce();
    expect(h.setSessionBudget).toHaveBeenCalledExactlyOnceWith(0.2, true, expect.any(Number));
    expect(h.receipts.get("request-1")?.state).toBe("completed");
  });
});
