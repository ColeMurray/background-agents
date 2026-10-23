import { beforeEach, describe, expect, it } from "vitest";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import { componentsOf, runInSessionDO } from "./session-do-access";
import {
  closeWebSocket,
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";

beforeEach(cleanD1Tables);

const AUTH_TOKEN = "orphan-reconcile-token";
const SANDBOX_ID = "sb-orphan-reconcile";
const REPLACED_MESSAGE = "The sandbox running this prompt was replaced.";
const RESTARTED_MESSAGE = "The sandbox runtime restarted while this prompt was running.";

function readyEvent(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ready",
    sandboxId: SANDBOX_ID,
    timestamp: Date.now() / 1000,
    harness: "opencode",
    ...extra,
  });
}

interface MessageState {
  status: string;
  error_message: string | null;
}

async function messageState(stub: DurableObjectStub, id: string): Promise<MessageState> {
  const [row] = await queryDO<MessageState>(
    stub,
    "SELECT status, error_message FROM messages WHERE id = ?",
    id
  );
  return row;
}

/**
 * A session whose sandbox instance was reserved at `instanceReservedAt`,
 * with a prompt processing since `startedAt` and another waiting behind it.
 */
async function seedSession(opts: {
  name: string;
  status: "connecting" | "ready";
  instanceReservedAt: number;
  startedAt: number;
}) {
  const { stub } = await initNamedSession(opts.name);
  await seedSandboxAuth(stub, {
    authToken: AUTH_TOKEN,
    sandboxId: SANDBOX_ID,
    status: opts.status,
  });
  await runInSessionDO(stub, (_instance: SessionDO, state) => {
    state.storage.sql.exec(
      "UPDATE sandbox SET created_at = ?, instance_reserved_at = ?",
      opts.instanceReservedAt,
      opts.instanceReservedAt
    );
  });
  const [{ id: authorId }] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants LIMIT 1"
  );
  await seedMessage(stub, {
    id: "msg-running",
    authorId,
    content: "Still marked processing",
    source: "web",
    status: "processing",
    createdAt: opts.startedAt - 1_000,
    startedAt: opts.startedAt,
  });
  await seedMessage(stub, {
    id: "msg-next",
    authorId,
    content: "Waits behind it",
    source: "web",
    status: "pending",
    createdAt: Date.now(),
  });
  return stub;
}

async function connectSandbox(name: string) {
  const { ws } = await openSandboxWs(name, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
  expect(ws).not.toBeNull();
  ws!.accept();
  return ws!;
}

describe("processing prompt reconciliation (via SELF.fetch)", () => {
  it("fails a prompt of a replaced sandbox when the replacement reports ready, and dispatches the next", async () => {
    const name = `orphan-replaced-${Date.now()}`;
    const instanceReservedAt = Date.now() - 5_000;
    const stub = await seedSession({
      name,
      status: "connecting",
      instanceReservedAt,
      startedAt: instanceReservedAt - 30_000,
    });

    const ws = await connectSandbox(name);
    try {
      const delivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
      ws.send(readyEvent({ activeMessageId: null }));

      expect((await delivery).find((message) => message.type === "prompt")).toEqual(
        expect.objectContaining({ messageId: "msg-next" })
      );
      expect(await messageState(stub, "msg-running")).toEqual({
        status: "failed",
        error_message: REPLACED_MESSAGE,
      });
      expect(await messageState(stub, "msg-next")).toMatchObject({ status: "processing" });
    } finally {
      await closeWebSocket(ws);
    }
  });

  it("fails a prompt a reconnecting bridge does not hold when it was dispatched before the socket attached", async () => {
    const name = `orphan-restarted-${Date.now()}`;
    const instanceReservedAt = Date.now() - 5_000;
    const stub = await seedSession({
      name,
      status: "ready",
      instanceReservedAt,
      startedAt: instanceReservedAt + 1_000,
    });

    const ws = await connectSandbox(name);
    try {
      const delivery = collectMessages(ws, { until: (message) => message.type === "prompt" });
      ws.send(readyEvent({ activeMessageId: null }));

      expect((await delivery).find((message) => message.type === "prompt")).toEqual(
        expect.objectContaining({ messageId: "msg-next" })
      );
      expect(await messageState(stub, "msg-running")).toEqual({
        status: "failed",
        error_message: RESTARTED_MESSAGE,
      });
    } finally {
      await closeWebSocket(ws);
    }
  });

  it("keeps a prompt the same bridge still runs after an in-place provider resume", async () => {
    const name = `orphan-resumed-in-place-${Date.now()}`;
    const instanceReservedAt = Date.now() - 60_000;
    const stub = await seedSession({
      name,
      status: "ready",
      instanceReservedAt,
      startedAt: instanceReservedAt + 1_000,
    });
    // E2B and Daytona resume in place: the same sandbox and bridge process
    // come back, while the generation's `created_at` advances.
    await runInSessionDO(stub, (instance: SessionDO) => {
      componentsOf(instance).sandboxRepository.updateSandboxForResume({
        status: "connecting",
        createdAt: Date.now(),
      });
    });

    const ws = await connectSandbox(name);
    try {
      const delivery = collectMessages(ws, {
        until: (message) => message.type === "prompt",
        timeoutMs: 500,
      });
      ws.send(readyEvent({ activeMessageId: "msg-running" }));

      expect((await delivery).find((message) => message.type === "prompt")).toBeUndefined();
      expect(await messageState(stub, "msg-running")).toEqual({
        status: "processing",
        error_message: null,
      });
      expect(await messageState(stub, "msg-next")).toMatchObject({ status: "pending" });
    } finally {
      await closeWebSocket(ws);
    }
  });

  it.each([
    { report: "the prompt it holds", extra: { activeMessageId: "msg-running" } },
    { report: "no report at all", extra: {} },
  ])("keeps the prompt when a reconnecting bridge sends $report", async ({ extra }) => {
    const name = `orphan-kept-${Date.now()}`;
    const instanceReservedAt = Date.now() - 5_000;
    const stub = await seedSession({
      name,
      status: "ready",
      instanceReservedAt,
      startedAt: instanceReservedAt + 1_000,
    });

    const ws = await connectSandbox(name);
    try {
      const delivery = collectMessages(ws, {
        until: (message) => message.type === "prompt",
        timeoutMs: 500,
      });
      ws.send(readyEvent(extra));

      expect((await delivery).find((message) => message.type === "prompt")).toBeUndefined();
      expect(await messageState(stub, "msg-running")).toEqual({
        status: "processing",
        error_message: null,
      });
      expect(await messageState(stub, "msg-next")).toMatchObject({ status: "pending" });
    } finally {
      await closeWebSocket(ws);
    }
  });
});
