import { afterEach, describe, it, expect, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { MIGRATIONS } from "../../src/session/schema";
import {
  initNamedSession,
  openClientWs,
  queryDO,
  seedMessage,
  waitForSandboxStatus,
} from "./helpers";

/**
 * Test-only field stamped onto a live instance so a test can prove the next
 * callback landed on a *different* object. Deliberately not one of the DO's own
 * fields: the upcoming composition-root refactor may rename or remove those,
 * and this check must keep working (or the tests below would silently stop
 * exercising reconstruction).
 */
const INSTANCE_MARKER = "pre-eviction-instance";
type MarkedSessionDO = SessionDO & { __evictionMarker?: string };

/**
 * Tear down the running instance and return a stub bound to its replacement.
 *
 * `ctx.abort()` discards every in-memory field — `initialized`, the WebSocket
 * manager's ClientInfo cache, every lazily built service — while leaving the
 * DO's SQLite intact. That is exactly the state a callback finds after an
 * eviction or a hibernation wake, and it is the one state the request-path
 * integration tests never reach.
 */
async function evictSessionDO(sessionName: string): Promise<DurableObjectStub> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionName));
  // Let the (always-failing) test spawn settle so no background write is still
  // in flight when abort() breaks the output gate.
  await waitForSandboxStatus(stub, "failed");
  await expect(
    runInDurableObject(stub, (instance: MarkedSessionDO) => {
      instance.__evictionMarker = INSTANCE_MARKER;
      return instance.__evictionMarker;
    })
  ).resolves.toBe(INSTANCE_MARKER);

  await expect(
    runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.abort("test: force eviction");
    })
  ).rejects.toThrow();

  const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
  // The marker is gone only if this really is a different object. Without this
  // check, a harness change that made abort() a no-op would leave every test
  // below green while none of them exercised reconstruction.
  await expect(
    runInDurableObject(restored, (instance: MarkedSessionDO) => instance.__evictionMarker)
  ).resolves.toBeUndefined();
  return restored;
}

/** Upper bound on how long a reply may take to cross the pair; matches `collectMessages`. */
const RESTORED_SOCKET_TIMEOUT_MS = 2000;

/**
 * Deliver one client frame the way a hibernating runtime does: over a socket
 * the running instance has never seen, carrying nothing but the `wsid:` tag
 * that survived in storage. Returns whatever the DO wrote back to that socket.
 *
 * Settles as soon as `until` matches a frame or the socket is closed, so no
 * caller depends on a fixed sleep. `collectMessages` in helpers.ts does the same
 * for frames, but cannot observe the close event the 4002 case asserts on, so
 * the wait is rebuilt here rather than reused.
 */
async function deliverOnRestoredSocket(
  stub: DurableObjectStub,
  wsId: string,
  message: unknown,
  // Default never matches: callers that expect no reply are settled by the close.
  opts: { until?: (frame: Record<string, unknown>) => boolean } = {}
): Promise<{
  received: Record<string, unknown>[];
  closes: { code: number; reason: string }[];
}> {
  const until = opts.until ?? (() => false);
  return runInDurableObject(stub, async (instance: SessionDO) => {
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const restoredSocket = pair[1];
    instance.ctx.acceptWebSocket(restoredSocket, [`wsid:${wsId}`]);
    clientSocket.accept();

    const received: Record<string, unknown>[] = [];
    const closes: { code: number; reason: string }[] = [];
    // Registered before the frame is delivered so nothing can be missed.
    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RESTORED_SOCKET_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      clientSocket.addEventListener("message", (event) => {
        const frame = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
          string,
          unknown
        >;
        received.push(frame);
        if (until(frame)) finish();
      });
      clientSocket.addEventListener("close", (event) => {
        closes.push({ code: event.code, reason: event.reason });
        finish();
      });
    });

    await instance.webSocketMessage(restoredSocket, JSON.stringify(message));
    await settled;
    return { received, closes };
  });
}

/** The single ws_client_mapping row a subscribed client leaves behind. */
async function persistedClientMapping(stub: DurableObjectStub) {
  const rows = await queryDO<{ ws_id: string; participant_id: string }>(
    stub,
    "SELECT ws_id, participant_id FROM ws_client_mapping"
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("SessionDO Durable Object", () => {
  it("returns 404 for uninitialized session state", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const response = await stub.fetch("http://internal/internal/state");
    expect(response.status).toBe(404);
  });

  it("initializes a session and returns state", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const initResponse = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-init",
        repoOwner: "acme",
        repoName: "web-app",
        repoId: 12345,
        title: "Integration test session",
        model: "anthropic/claude-haiku-4-5",
        userId: "user-1",
        scmLogin: "testuser",
      }),
    });
    expect(initResponse.status).toBe(200);

    const stateResponse = await stub.fetch("http://internal/internal/state");
    expect(stateResponse.status).toBe(200);

    const state = await stateResponse.json<{
      id: string;
      title: string;
      repoOwner: string;
      repoName: string;
      status: string;
      model: string;
    }>();
    expect(state.id).toBe("test-session-init");
    expect(state.title).toBe("Integration test session");
    expect(state.repoOwner).toBe("acme");
    expect(state.repoName).toBe("web-app");
    expect(state.status).toBe("created");
    expect(state.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("has SQLite tables accessible via runInDurableObject", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    // Initialize first so schema is created
    await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-sqlite",
        repoOwner: "acme",
        repoName: "api",
        userId: "user-2",
      }),
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const tables = instance.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .toArray();

      const tableNames = tables.map((row: Record<string, unknown>) => row.name);
      expect(tableNames).toContain("session");
      expect(tableNames).toContain("participants");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("events");
      expect(tableNames).toContain("artifacts");
      expect(tableNames).toContain("sandbox");
      expect(tableNames).toContain("ws_client_mapping");
      expect(tableNames).toContain("_schema_migrations");
    });
  });

  it("records all migration IDs in _schema_migrations", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-migrations",
        repoOwner: "acme",
        repoName: "api",
        userId: "user-3",
      }),
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const rows = instance.ctx.storage.sql
        .exec("SELECT id FROM _schema_migrations ORDER BY id")
        .toArray() as Array<{ id: number }>;

      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(MIGRATIONS.map((migration) => migration.id));
    });
  });

  describe("request log correlation", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function parseDoRequestLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
      const lines: Record<string, unknown>[] = [];
      for (const call of spy.mock.calls) {
        if (typeof call[0] !== "string") continue;
        try {
          const parsed = JSON.parse(call[0]) as Record<string, unknown>;
          if (parsed.event === "do.request") lines.push(parsed);
        } catch {
          // Not a structured log line.
        }
      }
      return lines;
    }

    it("tags each request's access log with its own trace id and leaves the session logger untouched", async () => {
      const id = env.SESSION.newUniqueId();
      const stub = env.SESSION.get(id);

      await stub.fetch("http://internal/internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName: "test-session-correlation",
          repoOwner: "acme",
          repoName: "api",
          userId: "user-4",
        }),
      });

      const spy = vi.spyOn(console, "log");

      // Overlapping requests with distinct trace ids. Under the old design
      // (fetch() mutated this.log and restored it in a finally), interleaved
      // completion could restore loggers out of order; each access log line
      // must carry exactly its own request's trace id.
      await Promise.all([
        stub.fetch("http://internal/internal/state", {
          headers: { "x-trace-id": "trace-a", "x-request-id": "req-a" },
        }),
        stub.fetch("http://internal/internal/state", {
          headers: { "x-trace-id": "trace-b", "x-request-id": "req-b" },
        }),
      ]);

      const correlated = parseDoRequestLines(spy);
      expect(correlated.map((line) => line.trace_id).sort()).toEqual(["trace-a", "trace-b"]);
      expect(correlated.map((line) => line.request_id).sort()).toEqual(["req-a", "req-b"]);

      // A request without correlation headers logs with the session logger:
      // no trace_id may linger from the earlier correlated requests.
      spy.mockClear();
      await stub.fetch("http://internal/internal/state");

      const uncorrelated = parseDoRequestLines(spy);
      expect(uncorrelated).toHaveLength(1);
      expect(uncorrelated[0]).not.toHaveProperty("trace_id");
      expect(uncorrelated[0]).not.toHaveProperty("request_id");
      expect(uncorrelated[0]).toHaveProperty("session_id");
    });
  });

  describe("eviction and hibernation restore", () => {
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

      // Reaching prompt_queued at all proves ensureInitialized() re-ran on the
      // new instance: the message queue is built from this.messenger, which
      // exists only after initialization.
      const { received, closes } = await deliverOnRestoredSocket(
        restored,
        mapping.ws_id,
        { type: "prompt", clientRequestId, content: "queued after eviction" },
        { until: (frame) => frame.type === "prompt_queued" }
      );

      expect(closes).toEqual([]);
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

      // The prompt starts another (failing) spawn; drain it before teardown.
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

      // Older than any execution timeout, so the alarm's stuck-message watchdog fires.
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
      await runInDurableObject(restored, (instance: SessionDO) =>
        instance.ctx.storage.setAlarm(Date.now() + 60_000)
      );

      await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);

      // Failing the message needs both halves of the graph ensureInitialized(false)
      // rebuilds: the alarm handler and the messenger it broadcasts through.
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

      const { received, closes } = await deliverOnRestoredSocket(
        restored,
        mapping.ws_id,
        { type: "presence", status: "idle" },
        { until: (frame) => frame.type === "presence_update" }
      );

      expect(closes).toEqual([]);
      // Presence is projected from the recovered ClientInfo, so the broadcast
      // is the DO reporting back every identity field it rebuilt from storage.
      expect(received.find((message) => message.type === "presence_update")).toMatchObject({
        participants: [
          {
            participantId: mapping.participant_id,
            // canonical_user_id wins over the raw user_id, as it does at subscribe time.
            userId: "canonical-user-42",
            name: "Ada Lovelace",
            avatar: "https://github.com/ada.png",
            status: "idle",
          },
        ],
      });
    });

    it("closes a restored socket with 4002 when no mapping survived", async () => {
      const sessionName = `do-evict-no-mapping-${Date.now()}`;
      await initNamedSession(sessionName);

      const restored = await evictSessionDO(sessionName);

      // No `until`: the only expected reply is the close itself, which settles the wait.
      const { received, closes } = await deliverOnRestoredSocket(
        restored,
        "ws-id-that-never-subscribed",
        { type: "typing" }
      );

      expect(received).toEqual([]);
      expect(closes).toEqual([{ code: 4002, reason: "Session expired, please reconnect" }]);
    });
  });
});
