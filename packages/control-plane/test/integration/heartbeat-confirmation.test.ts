import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import { runInSessionDO } from "./session-do-access";
import { initNamedSession, openSandboxWs, queryDO, seedMessage, seedSandboxAuth } from "./helpers";

const TOKEN = "heartbeat-test-token";
const SANDBOX_ID = "heartbeat-test-sandbox";

async function pendingEpisode(name: string) {
  const { stub } = await initNamedSession(name);
  await seedSandboxAuth(stub, { authToken: TOKEN, sandboxId: SANDBOX_ID });
  const [{ id: authorId }] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = 'user-1'"
  );
  await seedMessage(stub, {
    id: "active-prompt",
    authorId,
    content: "continue work",
    source: "web",
    status: "processing",
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 500,
  });
  const lastHeartbeat = Date.now() - 153_173;
  await runInSessionDO(stub, (_instance: SessionDO, state) => {
    state.storage.sql.exec(
      "UPDATE sandbox SET last_heartbeat = ?, last_activity = ?",
      lastHeartbeat,
      Date.now()
    );
  });
  await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
  const [row] = await queryDO<{
    status: string;
    last_heartbeat: number;
    heartbeat_confirmation_deadline: number;
  }>(stub, "SELECT status, last_heartbeat, heartbeat_confirmation_deadline FROM sandbox");
  expect(row.status).toBe("ready");
  expect(row.last_heartbeat).toBe(lastHeartbeat);
  expect(row.heartbeat_confirmation_deadline).toBeGreaterThan(Date.now());
  expect(await queryDO(stub, "SELECT status FROM messages WHERE id = 'active-prompt'")).toEqual([
    { status: "processing" },
  ]);
  return { stub, deadline: row.heartbeat_confirmation_deadline };
}

describe("heartbeat confirmation across SessionDO reconstruction", () => {
  beforeEach(cleanD1Tables);

  it("keeps the processing prompt when the bridge reconnects after eviction", async () => {
    const name = `heartbeat-recovered-${crypto.randomUUID()}`;
    const { stub, deadline } = await pendingEpisode(name);
    await expect(
      runInSessionDO(stub, (_instance: SessionDO, state) => {
        state.abort("test: reconstruct confirmation owner");
      })
    ).rejects.toThrow();
    const restored = env.SESSION.get(env.SESSION.idFromName(name));
    const { ws, response } = await openSandboxWs(name, { authToken: TOKEN, sandboxId: SANDBOX_ID });
    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    const [row] = await queryDO<{
      status: string;
      heartbeat_confirmation_deadline: number | null;
      last_heartbeat: number;
    }>(restored, "SELECT status, heartbeat_confirmation_deadline, last_heartbeat FROM sandbox");
    expect(row).toMatchObject({ status: "ready", heartbeat_confirmation_deadline: null });
    expect(row.last_heartbeat).toBeGreaterThan(deadline - 60_000);
    await runInSessionDO(restored, (instance: SessionDO) => instance.alarm());
    expect(
      await queryDO(restored, "SELECT status FROM messages WHERE id = 'active-prompt'")
    ).toEqual([{ status: "processing" }]);
    ws!.close();
  });

  it("retires an uncontacted ready generation after its persisted deadline", async () => {
    const name = `heartbeat-expired-${crypto.randomUUID()}`;
    const { stub } = await pendingEpisode(name);
    await expect(
      runInSessionDO(stub, (_instance: SessionDO, state) => {
        state.abort("test: reconstruct uncontacted confirmation owner");
      })
    ).rejects.toThrow();
    const restored = env.SESSION.get(env.SESSION.idFromName(name));
    await runInSessionDO(restored, (_instance: SessionDO, state) => {
      // Advance the persisted absolute deadline instead of sleeping in a workerd test.
      state.storage.sql.exec(
        "UPDATE sandbox SET heartbeat_confirmation_deadline = ?",
        Date.now() - 1
      );
    });
    await runInSessionDO(restored, (instance: SessionDO) => instance.alarm());
    expect(await queryDO(restored, "SELECT status FROM sandbox")).toEqual([{ status: "stale" }]);
    const [message] = await queryDO<{ status: string; error_message: string }>(
      restored,
      "SELECT status, error_message FROM messages WHERE id = 'active-prompt'"
    );
    expect(message.status).toBe("failed");
    expect(message.error_message).toContain("sandbox stopped responding");
  });
});
