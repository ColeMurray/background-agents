import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "../auth/crypto";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import type { SessionWebSocket } from "../platform-ports";
import { STOP_CONFIRMATION_TIMEOUT_MS } from "./message-repository";
import { SandboxCommandOutbox } from "./sandbox-command-outbox";
import { SCHEMA_SQL } from "./schema";
import type { MessageRow, SandboxCommand, SandboxRow } from "./types";
import {
  SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS,
  type SandboxCommandTarget,
  type SessionWebSocketManager,
} from "./websocket-manager";

const prompt: Extract<SandboxCommand, { type: "prompt" }> = {
  type: "prompt",
  messageId: "message-1",
  content: "Hello",
  author: { userId: "user-1", gitIdentity: { mode: "agent-only" } },
};
const push: Extract<SandboxCommand, { type: "push" }> = {
  type: "push",
  pushSpec: {
    remoteUrl: "https://secret-token@example.com/team/repo.git",
    redactedRemoteUrl: "https://***@example.com/team/repo.git",
    repoOwner: "team",
    repoName: "repo",
    targetBranch: "feature",
    refspec: "HEAD:refs/heads/feature",
    force: false,
  },
};

function setup() {
  const db = new DatabaseSync(":memory:");
  const { sql } = createNodeSqlStorage(db);
  sql.exec(SCHEMA_SQL);
  const ws = { readyState: 1 } as SessionWebSocket;
  const sandbox = {
    modal_sandbox_id: "sandbox-1",
    created_at: 1,
    status: "ready",
    last_heartbeat: Date.now(),
  } as SandboxRow;
  const message = { id: prompt.messageId, status: "processing" } as MessageRow;
  const messageRepository = {
    getMessageById: vi.fn((): MessageRow | null => message),
    getMessageAwaitingStopConfirmation: vi.fn((): { id: string; deadline: number } | null => null),
    setStopConfirmationRequirement: vi.fn(),
    resolveUnknownStopConfirmationPolicy: vi.fn(),
  };
  const wsManager = {
    getSandboxSocket: vi.fn((): SessionWebSocket | null => ws),
    getSandboxCommandTarget: vi.fn((): SandboxCommandTarget => ({ kind: "dispatch", socket: ws })),
    isActiveSandboxSocket: vi.fn(() => true),
    expectsSandboxReady: vi.fn(() => false),
    send: vi.fn((_ws: SessionWebSocket, _payload: string | object) => true),
    close: vi.fn(),
  };
  const deps = {
    sql,
    wsManager: wsManager as unknown as SessionWebSocketManager,
    sandboxRepository: { getSandbox: vi.fn((): SandboxRow | null => sandbox) },
    messageRepository,
    encryptionKey: crypto.generateEncryptionKey(),
    messenger: { broadcast: vi.fn() },
    mayDispatch: vi.fn(() => true),
    onUncertainDelivery: vi.fn(async () => {}),
  };
  const outbox = new SandboxCommandOutbox(deps);
  outbox.recordProtocol(true, "bridge-1", 1);
  const rows = () =>
    sql.exec("SELECT * FROM sandbox_command_outbox ORDER BY rowid").toArray() as Array<{
      command_id: string;
      message_id: string | null;
      payload: string;
      encrypted: number;
      attempted: number;
      expires_at: number;
    }>;
  return { db, sql, ws, sandbox, message, messageRepository, wsManager, deps, outbox, rows };
}

describe("SandboxCommandOutbox", () => {
  let h: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    h = setup();
  });

  afterEach(() => {
    h.db.close();
    vi.restoreAllMocks();
  });

  it("persists before sending and replays silent success with the same ID after reconstruction", async () => {
    h.wsManager.send.mockImplementation((_ws, payload) => {
      expect(h.rows()).toHaveLength(1);
      expect(h.rows()[0].payload).toBe(payload);
      return true;
    });
    expect(h.outbox.send(h.ws, prompt)).toBe(true);
    const row = h.rows()[0];
    expect(row.command_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.expires_at).toBe(Number.MAX_SAFE_INTEGER);
    expect(JSON.parse(row.payload)).toEqual({ ...prompt, commandId: row.command_id });
    await new SandboxCommandOutbox(h.deps).flush();
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
    expect(h.wsManager.send.mock.calls[1]).toEqual(h.wsManager.send.mock.calls[0]);
  });

  it("preserves supplied IDs and makes acknowledge and discard idempotent", async () => {
    h.outbox.send(h.ws, { ...prompt, commandId: "known-id" });
    expect(h.rows()[0].command_id).toBe("known-id");
    h.outbox.acknowledge("known-id");
    h.outbox.acknowledge("known-id");
    h.outbox.send(h.ws, { ...prompt, commandId: "discarded" });
    h.outbox.discard("discarded");
    h.outbox.discard("discarded");
    h.wsManager.send.mockClear();
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("removes a row when the initial transport send fails", () => {
    h.wsManager.send.mockReturnValue(false);
    expect(h.outbox.send(h.ws, prompt)).toBe(false);
    expect(h.rows()).toEqual([]);
  });

  it.each([true, false])(
    "delivers boot-time stops but not prompts or pushes (negotiated: %s)",
    async (negotiated) => {
      h.sandbox.status = "connecting";
      h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "booting", phase: null });
      if (!negotiated) h.sql.exec("DELETE FROM sandbox_command_protocol");
      expect(h.outbox.send(h.ws, prompt)).toBe(false);
      expect(await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000)).toBe(false);
      h.message.status = "failed";
      expect(h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId })).toBe(true);
      expect(h.wsManager.send).toHaveBeenCalledOnce();
      expect(JSON.parse(h.wsManager.send.mock.calls[0][1] as string)).toMatchObject({
        type: "stop",
        messageId: prompt.messageId,
        commandId: h.rows()[0].command_id,
      });
      await h.outbox.flush();
      expect(h.wsManager.send).toHaveBeenCalledTimes(negotiated ? 2 : 1);
      expect(h.wsManager.close).not.toHaveBeenCalled();
    }
  );

  it("holds a boot-time stop for fresh heartbeat and retries only a failed first send", async () => {
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "booting", phase: null });
    h.sql.exec("DELETE FROM sandbox_command_protocol");
    h.sandbox.last_heartbeat = Date.now() - SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS;
    h.message.status = "failed";
    expect(h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId })).toBe(true);
    await h.outbox.flush();
    expect(h.wsManager.send).not.toHaveBeenCalled();
    h.sandbox.last_heartbeat = Date.now();
    h.wsManager.send.mockReturnValueOnce(false);
    await h.outbox.flush();
    expect(h.rows()[0].attempted).toBe(0);
    await h.outbox.flush();
    expect(h.rows()[0].attempted).toBe(1);
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
  });

  it.each(["dead", "revoked", "replaced"] as const)(
    "rejects a stop on a %s lifecycle socket",
    async (state) => {
      h.message.status = "failed";
      if (state === "dead") h.wsManager.getSandboxSocket.mockReturnValue(null);
      if (state === "revoked") h.wsManager.isActiveSandboxSocket.mockReturnValue(false);
      if (state === "replaced")
        h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as SessionWebSocket);
      expect(h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId })).toBe(false);
      expect(h.rows()).toEqual([]);
      expect(h.wsManager.send).not.toHaveBeenCalled();
    }
  );

  it("persists protocol support only for the socket that announced it", async () => {
    h.outbox.send(h.ws, prompt);
    h.sandbox.active_socket_id = "replacement";
    const recovered = new SandboxCommandOutbox(h.deps);
    expect(recovered.supportsReplay()).toBe(false);
    await recovered.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    recovered.recordProtocol(true, "bridge-1", 1);
    await recovered.flush();
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
  });

  it("does not grant replay to migrated capability records without a receiver incarnation", () => {
    h.sql.exec("UPDATE sandbox_command_protocol SET bridge_instance_id = NULL, supported = 1");
    expect(h.outbox.supportsReplay()).toBe(false);
  });

  it("distinguishes unknown, legacy, and explicit stop-confirmation policies", () => {
    expect(h.outbox.requiresStopConfirmation()).toBe(true);
    h.sandbox.active_socket_id = "awaiting-ready";
    expect(h.outbox.requiresStopConfirmation()).toBeNull();
    h.outbox.recordProtocol(false);
    expect(h.outbox.requiresStopConfirmation()).toBe(false);
    h.sql.exec("DELETE FROM sandbox_command_protocol");
    expect(h.outbox.requiresStopConfirmation()).toBeNull();
  });

  it.each([true, false])(
    "binds a held stop's confirmation policy before delivery (explicit: %s)",
    async (explicit) => {
      h.sql.exec("DELETE FROM sandbox_command_protocol");
      h.message.status = "failed";
      expect(h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId })).toBe(true);
      expect(h.wsManager.send).not.toHaveBeenCalled();
      h.outbox.recordProtocol(
        explicit,
        explicit ? "bridge-1" : undefined,
        explicit ? 1 : undefined
      );
      h.wsManager.send.mockImplementation(() => {
        expect(h.messageRepository.setStopConfirmationRequirement).toHaveBeenCalledExactlyOnceWith(
          prompt.messageId,
          explicit
        );
        return true;
      });
      await h.outbox.flush();
      expect(h.wsManager.send).toHaveBeenCalledOnce();
    }
  );

  it("delivers never-sent commands to legacy runtimes but never replays them", async () => {
    h.outbox.recordProtocol(false);
    h.sandbox.last_heartbeat = null;
    expect(h.outbox.send(h.ws, prompt)).toBe(true);
    expect(h.wsManager.send).not.toHaveBeenCalled();
    h.sandbox.last_heartbeat = Date.now();
    await h.outbox.flush();
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    h.message.status = "completed";
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
  });

  it.each(["prompt", "push", "stop"] as const)(
    "contains uncertain %s delivery after a receiver-process restart",
    async (type) => {
      if (type === "push") await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000);
      else {
        if (type === "stop") h.message.status = "failed";
        h.outbox.send(
          h.ws,
          type === "prompt" ? prompt : { type: "stop", messageId: prompt.messageId }
        );
      }
      const commandId = h.rows()[0].command_id;
      h.sandbox.active_socket_id = "restarted-socket";
      const restarted = new SandboxCommandOutbox(h.deps);
      restarted.recordProtocol(true, "bridge-2", 1);
      await restarted.flush();
      expect(h.wsManager.send).toHaveBeenCalledOnce();
      expect(h.deps.onUncertainDelivery).toHaveBeenCalledExactlyOnceWith({ commandId, type });
      expect(h.rows()).toEqual([]);
    }
  );

  it("waits for receiver identity before first delivery, including after reconstruction", async () => {
    h.sql.exec("DELETE FROM sandbox_command_protocol");
    expect(h.outbox.send(h.ws, prompt)).toBe(true);
    expect(h.wsManager.send).not.toHaveBeenCalled();
    const restarted = new SandboxCommandOutbox(h.deps);
    restarted.recordProtocol(true, "bridge-2", 1);
    await restarted.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    expect(h.deps.onUncertainDelivery).not.toHaveBeenCalled();
    expect(h.sql.exec("SELECT bridge_instance_id FROM sandbox_command_outbox").toArray()).toEqual([
      { bridge_instance_id: "bridge-2" },
    ]);
  });

  it("refreshes negotiation for an existing ready socket with no persisted protocol", async () => {
    h.sql.exec("DELETE FROM sandbox_command_protocol");
    await h.outbox.flush();
    expect(h.wsManager.close).toHaveBeenCalledExactlyOnceWith(
      h.ws,
      1012,
      "Sandbox command negotiation required"
    );
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("keeps a fresh socket open and holds commands until ready, including after reconstruction", async () => {
    h.sandbox.active_socket_id = "fresh-socket";
    h.wsManager.expectsSandboxReady.mockReturnValue(true);
    const recovered = new SandboxCommandOutbox(h.deps);
    await recovered.flush();
    expect(recovered.send(h.ws, prompt)).toBe(true);
    await recovered.flush();
    expect(h.wsManager.close).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();
    recovered.recordProtocol(true, "bridge-1", 1);
    await recovered.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    expect(h.wsManager.close).not.toHaveBeenCalled();
  });

  it("retires a confirmed stop even when its receipt ACK was lost, matching command and message", async () => {
    h.message.status = "failed";
    h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId, commandId: "stop-1" });
    h.outbox.confirmStop("stop-1", "another-message");
    expect(h.rows()).toHaveLength(1);
    h.outbox.confirmStop("stop-1", prompt.messageId);
    h.outbox.confirmStop("stop-1", prompt.messageId);
    h.outbox.recordProtocol(true, "bridge-2", 1);
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.deps.onUncertainDelivery).not.toHaveBeenCalled();
  });

  it("rechecks receiver incarnation after push decryption", async () => {
    await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000);
    const decrypt = crypto.decryptToken;
    vi.spyOn(crypto, "decryptToken").mockImplementationOnce(async (...args) => {
      h.outbox.recordProtocol(true, "bridge-2", 1);
      return decrypt(...args);
    });
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    expect(h.deps.onUncertainDelivery).toHaveBeenCalledExactlyOnceWith({
      commandId: "push-1",
      type: "push",
    });
  });

  it.each([null, 100_000 - SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS])(
    "holds commands with heartbeat %s and replays only when fresh",
    async (heartbeat) => {
      h.sandbox.last_heartbeat = heartbeat;
      h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "reconnecting", socket: h.ws });
      expect(h.outbox.send(h.ws, prompt)).toBe(true);
      await h.outbox.flush();
      expect(h.rows()).toHaveLength(1);
      expect(h.wsManager.send).not.toHaveBeenCalled();
      h.sandbox.last_heartbeat = Date.now();
      await h.outbox.flush();
      expect(h.wsManager.send).toHaveBeenCalledOnce();
    }
  );

  it.each(["prompt", "push", "stop"] as const)(
    "retries a held %s after a failed first flush and legacy reconnect",
    async (type) => {
      h.outbox.recordProtocol(false);
      h.sandbox.last_heartbeat = null;
      if (type === "push") {
        expect(await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000)).toBe(true);
      } else {
        if (type === "stop") h.message.status = "failed";
        expect(
          h.outbox.send(
            h.ws,
            type === "prompt"
              ? prompt
              : {
                  type: "stop",
                  messageId: prompt.messageId,
                }
          )
        ).toBe(true);
      }
      const commandId = h.rows()[0].command_id;
      expect(h.wsManager.send).not.toHaveBeenCalled();
      h.sandbox.last_heartbeat = Date.now();
      h.wsManager.send.mockReturnValueOnce(false);
      await h.outbox.flush();
      expect(h.rows()[0]).toMatchObject({ command_id: commandId, attempted: 0 });

      const replacement = { readyState: 1 } as SessionWebSocket;
      h.sandbox.active_socket_id = "legacy-replacement";
      h.wsManager.getSandboxSocket.mockReturnValue(replacement);
      h.wsManager.getSandboxCommandTarget.mockReturnValue({
        kind: "dispatch",
        socket: replacement,
      });
      const recovered = new SandboxCommandOutbox(h.deps);
      recovered.recordProtocol(false);
      await recovered.flush();
      expect(h.wsManager.send).toHaveBeenCalledTimes(2);
      const [, payload] = h.wsManager.send.mock.calls[1];
      expect(h.wsManager.send.mock.calls[1][0]).toBe(replacement);
      expect(JSON.parse(payload as string)).toMatchObject({ type, commandId });
      expect(h.rows()[0].attempted).toBe(1);
      await recovered.flush();
      expect(h.wsManager.send).toHaveBeenCalledTimes(2);
    }
  );

  it("does not restore first-send eligibility when an already-attempted replay fails", async () => {
    h.outbox.send(h.ws, prompt);
    h.wsManager.send.mockReturnValueOnce(false);
    await h.outbox.flush();
    expect(h.rows()[0].attempted).toBe(1);
    h.sandbox.active_socket_id = "legacy-replacement";
    h.outbox.recordProtocol(false);
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
  });

  it("replays in insertion order and retains rows when a replay send fails", async () => {
    h.outbox.send(h.ws, { ...prompt, commandId: "z-first" });
    h.outbox.send(h.ws, { ...prompt, commandId: "a-second" });
    h.wsManager.send.mockClear().mockReturnValue(false);
    await h.outbox.flush();
    expect(
      h.wsManager.send.mock.calls.map(([, payload]) => JSON.parse(payload as string).commandId)
    ).toEqual(["z-first", "a-second"]);
    expect(h.rows()).toHaveLength(2);
  });

  it.each([
    "sandbox-id",
    "created-at",
    "completed",
    "failed",
    "missing-message",
    "missing-sandbox",
  ])("deletes obsolete prompts: %s", async (change) => {
    h.outbox.send(h.ws, prompt);
    h.wsManager.send.mockClear();
    if (change === "sandbox-id") h.sandbox.modal_sandbox_id = "replacement";
    if (change === "created-at") h.sandbox.created_at++;
    if (change === "completed" || change === "failed") h.message.status = change;
    if (change === "missing-message") h.messageRepository.getMessageById.mockReturnValue(null);
    if (change === "missing-sandbox") h.deps.sandboxRepository.getSandbox.mockReturnValue(null);
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("holds ordinary work when admission is revoked but still delivers targeted stops", async () => {
    h.outbox.send(h.ws, prompt);
    h.deps.mayDispatch.mockReturnValue(false);
    h.wsManager.send.mockClear();
    await h.outbox.flush();
    expect(h.rows()).toHaveLength(1);
    expect(h.wsManager.send).not.toHaveBeenCalled();
    expect(h.outbox.send(h.ws, prompt)).toBe(false);
    h.messageRepository.getMessageAwaitingStopConfirmation.mockReturnValue({
      id: prompt.messageId,
      deadline: Date.now() + STOP_CONFIRMATION_TIMEOUT_MS,
    });
    expect(h.outbox.send(h.ws, { type: "stop" })).toBe(true);
    expect(JSON.parse(h.rows()[1].payload)).toMatchObject({
      type: "stop",
      messageId: prompt.messageId,
    });
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
  });

  it("expires cancellation stops and excludes stops no longer awaiting confirmation", async () => {
    h.message.status = "failed";
    expect(h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId })).toBe(true);
    expect(h.rows()[0].expires_at).toBe(Date.now() + STOP_CONFIRMATION_TIMEOUT_MS);
    h.wsManager.send.mockClear();
    await h.outbox.flush();
    expect(h.wsManager.send).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(100_000 + STOP_CONFIRMATION_TIMEOUT_MS);
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.wsManager.send).toHaveBeenCalledOnce();

    h.sandbox.last_heartbeat = Date.now();
    h.outbox.send(h.ws, { type: "stop", messageId: prompt.messageId });
    h.message.status = "completed";
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.outbox.send(h.ws, { type: "stop", messageId: "unrelated" })).toBe(false);
  });

  it.each(["booting", "unavailable", "revoked", "replaced"])(
    "does not persist or replay against a %s target",
    async (change) => {
      h.outbox.send(h.ws, prompt);
      h.wsManager.send.mockClear();
      if (change === "booting")
        h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "booting", phase: null });
      if (change === "unavailable")
        h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });
      if (change === "revoked") h.wsManager.isActiveSandboxSocket.mockReturnValue(false);
      if (change === "replaced")
        h.wsManager.getSandboxCommandTarget.mockReturnValue({
          kind: "dispatch",
          socket: {} as SessionWebSocket,
        });
      expect(h.outbox.send(h.ws, prompt)).toBe(false);
      if (change !== "replaced") await h.outbox.flush();
      expect(h.wsManager.send).not.toHaveBeenCalled();
      expect(h.rows()).toHaveLength(1);
    }
  );

  it("encrypts the entire push payload at rest and replays its original command ID", async () => {
    expect(await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000)).toBe(true);
    const row = h.rows()[0];
    expect(row.encrypted).toBe(1);
    expect(row.payload).not.toContain("secret-token");
    expect(row.payload).not.toContain("pushSpec");
    expect(JSON.parse(await crypto.decryptToken(row.payload, h.deps.encryptionKey))).toEqual({
      ...push,
      commandId: "push-1",
    });
    await h.outbox.flush();
    expect(h.wsManager.send.mock.calls[1]).toEqual(h.wsManager.send.mock.calls[0]);
    vi.mocked(Date.now).mockReturnValue(101_000);
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.wsManager.send).toHaveBeenCalledTimes(2);
  });

  it("holds encrypted pushes on stale sockets and removes failed initial sends", async () => {
    h.sandbox.last_heartbeat = null;
    expect(await h.outbox.sendPush(h.ws, push, "held", Date.now() + 1000)).toBe(true);
    expect(h.wsManager.send).not.toHaveBeenCalled();
    h.sandbox.last_heartbeat = Date.now();
    h.wsManager.send.mockReturnValue(false);
    expect(await h.outbox.sendPush(h.ws, push, "failed", Date.now() + 1000)).toBe(false);
    expect(h.rows().map((row) => row.command_id)).toEqual(["held"]);
  });

  const races = ["generation", "admission", "authority", "socket", "expiry"] as const;
  function revoke(change: (typeof races)[number]) {
    if (change === "generation") h.sandbox.created_at++;
    if (change === "admission") h.deps.mayDispatch.mockReturnValue(false);
    if (change === "authority") h.wsManager.isActiveSandboxSocket.mockReturnValue(false);
    if (change === "socket")
      h.wsManager.getSandboxCommandTarget.mockReturnValue({
        kind: "dispatch",
        socket: {} as SessionWebSocket,
      });
    if (change === "expiry") vi.mocked(Date.now).mockReturnValue(101_000);
  }

  it.each(races)("rechecks %s after encryption before persisting", async (change) => {
    const encrypt = crypto.encryptToken;
    vi.spyOn(crypto, "encryptToken").mockImplementationOnce(async (...args) => {
      const encrypted = await encrypt(...args);
      revoke(change);
      return encrypted;
    });
    expect(await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000)).toBe(false);
    expect(h.rows()).toEqual([]);
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it.each([...races, "ack", "discard", "stale"] as const)(
    "rechecks %s after decryption before replaying",
    async (change) => {
      await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000);
      h.wsManager.send.mockClear();
      const decrypt = crypto.decryptToken;
      vi.spyOn(crypto, "decryptToken").mockImplementationOnce(async (...args) => {
        const payload = await decrypt(...args);
        if (change === "ack") h.outbox.acknowledge("push-1");
        else if (change === "discard") h.outbox.discard("push-1");
        else if (change === "stale") h.sandbox.last_heartbeat = null;
        else revoke(change);
        return payload;
      });
      await h.outbox.flush();
      expect(h.wsManager.send).not.toHaveBeenCalled();
      expect(h.rows()).toHaveLength(
        ["generation", "expiry", "ack", "discard"].includes(change) ? 0 : 1
      );
    }
  );

  it("rechecks later prompt state after decrypting an earlier push", async () => {
    await h.outbox.sendPush(h.ws, push, "push-1", Date.now() + 1000);
    h.outbox.send(h.ws, prompt);
    h.wsManager.send.mockClear();
    const decrypt = crypto.decryptToken;
    vi.spyOn(crypto, "decryptToken").mockImplementationOnce(async (...args) => {
      h.message.status = "completed";
      return decrypt(...args);
    });
    await h.outbox.flush();
    expect(h.rows().map((row) => row.command_id)).toEqual(["push-1"]);
    expect(h.wsManager.send).toHaveBeenCalledOnce();
  });
});
