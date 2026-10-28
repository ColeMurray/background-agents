import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { SUBSCRIPTION_PROVIDER_IDS } from "@open-inspect/shared/types/provider-accounts";
import { generateEncryptionKey } from "../auth/crypto";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { createSessionRuntime } from "../session/components";
import { SessionMessageQueue } from "../session/message-queue";
import { initSchema } from "../session/schema";
import type { Env } from "../types";
import { DEFAULT_MIGRATIONS_DIR } from "./config";
import { applyMigrations } from "./migrate";
import { NodeWebSocketHost } from "./socket-host";
import { createNodeSqlDatabase } from "./sqlite-database";
import { createNodeSqlStorage } from "./sqlite-storage";

it("does not deliver a prompt when the Node message-claim COMMIT fails (review4396879343)", async () => {
  const sessionDb = new DatabaseSync(":memory:");
  const globalDb = new DatabaseSync(":memory:");
  const background = createTestBackgroundTasks();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let client: NodeWebSocket | undefined;

  try {
    await once(server, "listening");
    applyMigrations(globalDb, DEFAULT_MIGRATIONS_DIR);
    const db = createNodeSqlDatabase(globalDb);
    const storage = createNodeSqlStorage(sessionDb);
    const { sql } = storage;
    initSchema(sql);
    const encryptionKey = generateEncryptionKey();
    const now = Date.now();
    const sessionId = "command-commit-session";
    const messageId = "message-1";
    const model = "anthropic/claude-haiku-4-5";

    await new SessionIndexStore(db).create({
      id: sessionId,
      title: null,
      repoOwner: "acme",
      repoName: "repo",
      model,
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      ownerTeamId: null,
      visibility: "workspace",
      createdAt: now,
      updatedAt: now,
      providerAuth: SUBSCRIPTION_PROVIDER_IDS.map((provider) => ({
        provider,
        authMode: "api_key",
        selectionSource: "explicit",
      })),
    });
    await new GlobalSecretsStore(db, encryptionKey).setSecrets({
      ANTHROPIC_API_KEY: "test-only-api-key",
    });
    sql.exec(
      `INSERT INTO session
       (id, session_name, repo_owner, repo_name, repo_id, base_branch, model, status, created_at, updated_at)
       VALUES (?, ?, 'acme', 'repo', 1, 'main', ?, 'active', ?, ?)`,
      sessionId,
      sessionId,
      model,
      now,
      now
    );
    sql.exec(
      `INSERT INTO participants (id, user_id, role, joined_at)
       VALUES ('participant-1', 'user-1', 'owner', ?)`,
      now
    );
    sql.exec(
      `INSERT INTO sandbox (id, modal_sandbox_id, status, last_heartbeat, created_at)
       VALUES ('sandbox-row', 'sandbox-1', 'connecting', ?, ?)`,
      now,
      now
    );

    const sockets = new NodeWebSocketHost(createLogger("command-delivery-test", {}, "error"));
    let alarmAt: number | null = null;
    const runtime = createSessionRuntime(
      {
        id: sessionId,
        storage,
        db,
        sockets,
        alarmStore: {
          getAlarm: async () => alarmAt,
          setAlarm: async (at) => {
            alarmAt = at;
          },
          deleteAlarm: async () => {
            alarmAt = null;
          },
        },
        createBackgroundTasks: () => background,
      },
      {
        REPO_SECRETS_ENCRYPTION_KEY: encryptionKey,
        TOKEN_ENCRYPTION_KEY: encryptionKey,
        PROVIDER_ACCOUNTS_ENCRYPTION_KEY: encryptionKey,
        MODAL_API_SECRET: "test-only-modal-secret",
        MODAL_WORKSPACE: "test",
        LOG_LEVEL: "error",
      } as Env
    );
    // Only outbound transport is under test; teardown must not initiate sandbox recovery.
    sockets.bindEventSink({
      onMessage: async () => {},
      onClose: async () => {},
      onError: () => {},
    });
    const connected = once(server, "connection");
    client = new NodeWebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const frames: string[] = [];
    client.on("message", (data) => frames.push(String(data)));
    await once(client, "open");
    const [socket] = (await connected) as [NodeWebSocket];
    runtime.internals.wsManager.acceptAndSetSandboxSocket(socket, "sandbox-1");
    await runtime.internals.sandboxEventProcessor.processSandboxEvent({
      type: "ready",
      sandboxId: "sandbox-1",
      timestamp: now / 1000,
      commandAckVersion: 1,
      bridgeInstanceId: "bridge-1",
      stopConfirmationVersion: 1,
    });
    await background.settle();
    expect(background.failures).toEqual([]);
    expect(runtime.internals.wsManager.getSandboxCommandTarget()).toEqual({
      kind: "dispatch",
      socket,
    });

    // Ready has finished pumping an empty queue before the pending prompt is seeded.
    sql.exec(
      `INSERT INTO messages (id, author_id, content, source, status, created_at)
       VALUES (?, 'participant-1', 'Run exactly once', 'web', 'pending', ?)`,
      messageId,
      now
    );
    const message = () =>
      sql.exec("SELECT id, status, started_at FROM messages WHERE id = ?", messageId).one();
    const promptEvents = () =>
      sql.exec("SELECT * FROM events WHERE message_id = ?", messageId).toArray();
    const outbox = () => sql.exec("SELECT * FROM sandbox_command_outbox").toArray();
    const initialEvents = sql.exec("SELECT * FROM events ORDER BY timeline_sequence").toArray();
    const pending = message();
    expect(pending).toEqual({ id: messageId, status: "pending", started_at: null });
    const queue = runtime.internals.messageQueue;
    expect(queue).toBeInstanceOf(SessionMessageQueue);

    const commitError = new Error("Injected Node COMMIT failure");
    const exec = sessionDb.exec.bind(sessionDb);
    let failCommit = true;
    let beforeFailedCommit: unknown;
    const execSpy = vi.spyOn(sessionDb, "exec").mockImplementation((query) => {
      if (query === "COMMIT" && failCommit) {
        failCommit = false;
        beforeFailedCommit = {
          message: message(),
          events: promptEvents(),
          outbox: outbox(),
        };
        throw commitError;
      }
      // In particular, execute the adapter's real ROLLBACK and all retry transactions.
      return exec(query);
    });

    // A pong follows all preceding server-to-client data on this TCP connection.
    // This observes escaped frames at the peer, without a timing-dependent sleep.
    const drainFrames = async () => {
      const pong = once(socket, "pong", { signal: AbortSignal.timeout(2_000) });
      socket.ping();
      await pong;
    };

    await expect(queue.processMessageQueue()).rejects.toBe(commitError);
    expect(beforeFailedCommit).toMatchObject({
      message: { id: messageId, status: "processing", started_at: expect.any(Number) },
      events: [expect.objectContaining({ type: "user_message", message_id: messageId })],
      outbox: [
        expect.objectContaining({
          command_id: expect.any(String),
          message_id: messageId,
          command_type: "prompt",
        }),
      ],
    });
    expect(execSpy).toHaveBeenCalledWith("ROLLBACK");
    expect(message()).toEqual(pending);
    expect(promptEvents()).toEqual([]);
    expect(sql.exec("SELECT * FROM events ORDER BY timeline_sequence").toArray()).toEqual(
      initialEvents
    );
    expect(outbox()).toEqual([]);
    await drainFrames();
    expect(frames).toEqual([]);

    await queue.processMessageQueue();
    // A further pump must not dispatch the already-processing prompt again.
    await queue.processMessageQueue();
    await background.settle();
    await drainFrames();
    expect(background.failures).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(message()).toEqual({
      id: messageId,
      status: "processing",
      started_at: expect.any(Number),
    });
    expect(promptEvents()).toHaveLength(1);
    expect(outbox()).toEqual([
      expect.objectContaining({
        command_id: expect.any(String),
        command_type: "prompt",
        message_id: messageId,
        payload: frames[0],
        attempted: 1,
        bridge_instance_id: "bridge-1",
      }),
    ]);
    const [persisted] = outbox() as Array<{ command_id: string }>;
    expect(JSON.parse(frames[0])).toMatchObject({
      type: "prompt",
      messageId,
      commandId: persisted.command_id,
      content: "Run exactly once",
    });
  } finally {
    vi.restoreAllMocks();
    client?.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await background.settle();
    sessionDb.close();
    globalDb.close();
  }
});
