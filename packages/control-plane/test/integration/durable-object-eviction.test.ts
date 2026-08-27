import { beforeEach, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { runInSessionDO } from "./session-do-access";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import {
  INTEGRATION_WEBSOCKET_TIMEOUT_MS,
  initNamedSession,
  openClientWs,
  queryDO,
  seedMessage,
  waitForSandboxStatus,
} from "./helpers";

const INSTANCE_MARKER = "pre-eviction-instance";

type MarkedSessionDO = SessionDO & { __evictionMarker?: string };

/** Tear down the running instance and return a stub bound to its replacement. */
async function evictSessionDO(sessionName: string): Promise<DurableObjectStub> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionName));
  await waitForSandboxStatus(stub, "failed");
  await expect(
    runInSessionDO(stub, (instance: MarkedSessionDO) => {
      instance.__evictionMarker = INSTANCE_MARKER;
      return instance.__evictionMarker;
    })
  ).resolves.toBe(INSTANCE_MARKER);

  await expect(
    runInSessionDO(stub, (instance: SessionDO, state) => {
      state.abort("test: force eviction");
    })
  ).rejects.toThrow();

  const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
  await expect(
    runInSessionDO(restored, (instance: MarkedSessionDO) => instance.__evictionMarker)
  ).resolves.toBeUndefined();
  return restored;
}

/** Deliver one frame over a socket reconstructed only from its persisted wsid tag. */
async function deliverOnRestoredSocket(
  stub: DurableObjectStub,
  wsId: string,
  message: unknown,
  until: (frame: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>[]> {
  return runInSessionDO(stub, async (instance: SessionDO, state) => {
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const restoredSocket = pair[1];
    state.acceptWebSocket(restoredSocket, [`wsid:${wsId}`]);
    clientSocket.accept();

    const received: Record<string, unknown>[] = [];
    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INTEGRATION_WEBSOCKET_TIMEOUT_MS);
      clientSocket.addEventListener("message", (event) => {
        const frame = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
          string,
          unknown
        >;
        received.push(frame);
        if (until(frame)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await instance.webSocketMessage(restoredSocket, JSON.stringify(message));
    await settled;
    return received;
  });
}

async function persistedClientMapping(stub: DurableObjectStub) {
  const rows = await queryDO<{ ws_id: string; participant_id: string }>(
    stub,
    "SELECT ws_id, participant_id FROM ws_client_mapping"
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("SessionDO eviction and hibernation restore", () => {
  beforeEach(cleanD1Tables);

  it("handles a client prompt delivered to a reconstructed instance", async () => {
    const sessionName = `do-evict-prompt-${Date.now()}`;
    await initNamedSession(sessionName);
    const { ws } = await openClientWs(sessionName, { subscribe: true });
    const mapping = await persistedClientMapping(
      env.SESSION.get(env.SESSION.idFromName(sessionName))
    );
    ws.close();

    const restored = await evictSessionDO(sessionName);
    const clientRequestId = crypto.randomUUID();
    const received = await deliverOnRestoredSocket(
      restored,
      mapping.ws_id,
      { type: "prompt", clientRequestId, content: "queued after eviction" },
      (frame) => frame.type === "prompt_queued"
    );

    expect(received).toContainEqual(
      expect.objectContaining({ type: "prompt_queued", clientRequestId })
    );
    const messages = await queryDO<{ content: string; author_id: string }>(
      restored,
      "SELECT content, author_id FROM messages"
    );
    expect(messages).toEqual([
      { content: "queued after eviction", author_id: mapping.participant_id },
    ]);
    await waitForSandboxStatus(restored, "failed");
  });

  it("runs the alarm handler on a reconstructed instance", async () => {
    const sessionName = `do-evict-alarm-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const tokenResponse = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });
    const { participantId } = await tokenResponse.json<{ participantId: string }>();

    const startedAt = Date.now() - 24 * 60 * 60 * 1000;
    await seedMessage(stub, {
      id: "stuck-across-eviction",
      authorId: participantId,
      content: "stuck",
      source: "web",
      status: "processing",
      createdAt: startedAt,
      startedAt,
    });

    const restored = await evictSessionDO(sessionName);
    await runInSessionDO(restored, (instance: SessionDO, state) =>
      state.storage.setAlarm(Date.now() + 60_000)
    );

    await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);
    const messages = await queryDO<{ status: string; error_message: string | null }>(
      restored,
      "SELECT status, error_message FROM messages"
    );
    expect(messages).toEqual([
      { status: "failed", error_message: "Execution timed out (stuck processing)" },
    ]);
  });

  it("rebuilds client identity from ws_client_mapping when the in-memory cache is gone", async () => {
    const sessionName = `do-evict-identity-${Date.now()}`;
    await initNamedSession(sessionName);
    const { ws } = await openClientWs(sessionName, {
      subscribe: true,
      userId: "user-1",
      canonicalUserId: "canonical-user-42",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
    });
    const mapping = await persistedClientMapping(
      env.SESSION.get(env.SESSION.idFromName(sessionName))
    );
    ws.close();

    const restored = await evictSessionDO(sessionName);
    const received = await deliverOnRestoredSocket(
      restored,
      mapping.ws_id,
      { type: "presence", status: "idle" },
      (frame) => frame.type === "presence_update"
    );

    expect(received.find((message) => message.type === "presence_update")).toMatchObject({
      participants: [
        {
          participantId: mapping.participant_id,
          userId: "canonical-user-42",
          name: "Ada Lovelace",
          avatar: "https://github.com/ada.png",
          status: "idle",
        },
      ],
    });
  });
});
