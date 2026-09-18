/**
 * Unit tests for the WebSocket upgrade decision: every guard is driven through
 * `authorize` with fake collaborators, and `attach` is checked for the side
 * effects each accepted role runs on the host's socket.
 */

import { describe, it, expect, vi } from "vitest";
import { hashToken } from "../auth/crypto";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import {
  SessionConnectionAuthenticator,
  type SessionConnectionAuthenticatorDeps,
} from "./connection-authenticator";
import type { SandboxRow, SessionRow } from "./types";

const TOKEN = "sandbox-token";
const SANDBOX_ID = "sb-1";

function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

async function sandboxRow(overrides: Partial<SandboxRow> = {}): Promise<SandboxRow> {
  return {
    id: "row",
    modal_sandbox_id: SANDBOX_ID,
    auth_token: null,
    auth_token_hash: await hashToken(TOKEN),
    status: "ready",
    created_at: 5000,
    ...overrides,
  } as SandboxRow;
}

function sessionRow(status: SessionRow["status"]): SessionRow {
  return { id: "session", status } as SessionRow;
}

function upgradeRequest(opts: {
  sandbox?: boolean;
  token?: string | null;
  sandboxId?: string | null;
  traceId?: string;
}): Request {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.sandboxId) headers["X-Sandbox-ID"] = opts.sandboxId;
  const query = opts.sandbox ? "?type=sandbox" : "";
  return new Request(`https://session.local/sessions/s/ws${query}`, { headers });
}

interface Harness {
  authenticator: SessionConnectionAuthenticator;
  log: Logger;
  sandboxRepository: {
    getSandbox: ReturnType<typeof vi.fn>;
    updateSandboxStatus: ReturnType<typeof vi.fn>;
    updateSandboxHeartbeat: ReturnType<typeof vi.fn>;
  };
  wsManager: {
    acceptClientSocket: ReturnType<typeof vi.fn>;
    acceptAndSetSandboxSocket: ReturnType<typeof vi.fn>;
    getReadySandboxSocket: ReturnType<typeof vi.fn>;
    enforceAuthTimeout: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  lifecycleManager: {
    isProviderStartupPending: ReturnType<typeof vi.fn>;
    onSandboxConnected: ReturnType<typeof vi.fn>;
    onSandboxSocketAttached: ReturnType<typeof vi.fn>;
    updateLastActivity: ReturnType<typeof vi.fn>;
    scheduleInactivityCheck: ReturnType<typeof vi.fn>;
    scheduleDisconnectCheck: ReturnType<typeof vi.fn>;
  };
  broadcast: ReturnType<typeof vi.fn>;
  submitted: string[];
  processMessageQueue: ReturnType<typeof vi.fn>;
}

function createHarness(opts: {
  sandbox: SandboxRow | null;
  session?: SessionRow | null;
  /** Called on the second sandbox read, standing in for a write landing mid-await. */
  duringTokenHash?: () => SandboxRow | null;
}): Harness {
  const log = createLogger();
  let reads = 0;
  const sandboxRepository = {
    getSandbox: vi.fn(() => {
      reads += 1;
      if (reads > 1 && opts.duringTokenHash) return opts.duringTokenHash();
      return opts.sandbox;
    }),
    updateSandboxStatus: vi.fn(),
    updateSandboxHeartbeat: vi.fn(),
  };
  const wsManager = {
    acceptClientSocket: vi.fn(),
    acceptAndSetSandboxSocket: vi.fn(() => ({ replaced: false })),
    getReadySandboxSocket: vi.fn(() => null as WebSocket | null),
    enforceAuthTimeout: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const lifecycleManager = {
    isProviderStartupPending: vi.fn(() => false),
    onSandboxConnected: vi.fn(),
    onSandboxSocketAttached: vi.fn(),
    updateLastActivity: vi.fn(),
    scheduleInactivityCheck: vi.fn(async () => undefined),
    scheduleDisconnectCheck: vi.fn(async () => undefined),
  };
  const broadcast = vi.fn();
  const submitted: string[] = [];
  const backgroundTasks: BackgroundTasks = {
    submit: (task, metadata) => {
      submitted.push(metadata.name);
      void task();
    },
  };
  const processMessageQueue = vi.fn(async () => undefined);
  const deps = {
    wsManager,
    sessionCoreRepository: { getSession: () => opts.session ?? sessionRow("active") },
    sandboxRepository,
    lifecycleManager,
    messenger: { broadcast },
    backgroundTasks,
    messageQueue: { processMessageQueue },
    log,
  } as unknown as SessionConnectionAuthenticatorDeps;
  return {
    authenticator: new SessionConnectionAuthenticator(deps),
    log,
    sandboxRepository,
    wsManager,
    lifecycleManager,
    broadcast,
    submitted,
    processMessageQueue,
  };
}

async function rejection(
  decision: Awaited<ReturnType<SessionConnectionAuthenticator["authorize"]>>
) {
  if (decision.kind !== "reject") throw new Error(`expected a rejection, got ${decision.role}`);
  return { status: decision.response.status, body: await decision.response.text() };
}

describe("SessionConnectionAuthenticator.authorize", () => {
  it("accepts a client upgrade with a fresh ws id and no guards", async () => {
    const h = createHarness({ sandbox: null });

    const decision = await h.authenticator.authorize(upgradeRequest({}));

    expect(decision).toMatchObject({ kind: "accept", role: "client" });
    expect(h.sandboxRepository.getSandbox).not.toHaveBeenCalled();
  });

  it("accepts a sandbox upgrade carrying the presented sandbox id", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID })
    );

    expect(decision).toMatchObject({ kind: "accept", role: "sandbox" });
  });

  it("rejects a wrong sandbox id with 403 before checking the token", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: "not-even-checked", sandboxId: "stale" })
    );

    expect(await rejection(decision)).toEqual({ status: 403, body: "Forbidden: Wrong sandbox ID" });
    expect(h.log.warn).toHaveBeenCalledWith(
      "ws.connect",
      expect.objectContaining({ reject_reason: "sandbox_id_mismatch" })
    );
  });

  it("rejects an invalid token with 401", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: "wrong", sandboxId: SANDBOX_ID })
    );

    expect(await rejection(decision)).toEqual({
      status: 401,
      body: "Unauthorized: Invalid auth token",
    });
  });

  it("rejects a stopped sandbox with 401, not 410, when the token is invalid", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ status: "stopped" }) });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: "wrong", sandboxId: SANDBOX_ID })
    );

    expect((await rejection(decision)).status).toBe(401);
  });

  it("rejects a terminal session with 410 on a read taken after authentication", async () => {
    const h = createHarness({ sandbox: await sandboxRow(), session: sessionRow("cancelled") });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID })
    );

    expect(await rejection(decision)).toEqual({ status: 410, body: "Session is terminal" });
  });

  it("rejects a sandbox that stopped during the token hash with 410", async () => {
    const row = await sandboxRow();
    const h = createHarness({
      sandbox: row,
      duringTokenHash: () => ({ ...row, status: "stopped" }),
    });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID })
    );

    expect(await rejection(decision)).toEqual({ status: 410, body: "Sandbox is stopped" });
  });

  it("rejects credentials rotated during the token hash with 403", async () => {
    const row = await sandboxRow();
    const h = createHarness({
      sandbox: row,
      duringTokenHash: () => ({ ...row, auth_token_hash: "rotated" }),
    });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID })
    );

    expect(await rejection(decision)).toEqual({
      status: 403,
      body: "Forbidden: Sandbox credentials changed",
    });
  });

  it("rejects a sandbox replaced during the token hash with 403", async () => {
    const row = await sandboxRow();
    const h = createHarness({
      sandbox: row,
      duringTokenHash: () => ({ ...row, modal_sandbox_id: "sb-2" }),
    });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID })
    );

    expect((await rejection(decision)).status).toBe(403);
  });

  it("accepts a bridge for a sandbox row that has no id yet", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ modal_sandbox_id: null }) });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: "anything" })
    );

    expect(decision).toMatchObject({ kind: "accept", role: "sandbox" });
  });
});

async function accepted(h: Harness, request: Request) {
  const decision = await h.authenticator.authorize(request);
  if (decision.kind !== "accept") throw new Error("expected an acceptance");
  return decision;
}

const sandboxUpgrade = () => upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID });

describe("UpgradeDecision.attach", () => {
  const socket = {} as WebSocket;

  it("registers a client socket under its ws id and arms the authentication timeout", async () => {
    const h = createHarness({ sandbox: null });

    await (await accepted(h, upgradeRequest({}))).attach(socket);

    expect(h.wsManager.acceptClientSocket).toHaveBeenCalledOnce();
    const [, wsId] = h.wsManager.acceptClientSocket.mock.calls[0] as [WebSocket, string];
    expect(wsId).toMatch(/^ws-\d+-[a-z0-9]+$/);
    expect(h.submitted).toEqual(["websocket.enforce_auth_timeout"]);
    expect(h.wsManager.enforceAuthTimeout).toHaveBeenCalledWith(socket, wsId);
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("moves the sandbox to connecting for its generation, stamps the heartbeat, arms boot liveness, and publishes access", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ status: "spawning" }) });

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(h.wsManager.acceptAndSetSandboxSocket).toHaveBeenCalledWith(socket, SANDBOX_ID);
    expect(h.sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledOnce();
    expect(h.lifecycleManager.onSandboxConnected).toHaveBeenCalledOnce();
    expect(h.lifecycleManager.onSandboxSocketAttached).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID,
      createdAt: 5000,
    });
    expect(h.lifecycleManager.scheduleDisconnectCheck).toHaveBeenCalledOnce();
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).toEqual([
      "sandbox_access_changed",
    ]);
    expect(h.log.info).toHaveBeenCalledWith(
      "ws.connect",
      expect.objectContaining({ outcome: "success", sandbox_id: SANDBOX_ID })
    );
  });

  it("neither publishes ready nor pumps the queue nor stamps activity: those wait for the ready event", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ status: "connecting" }) });

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(h.sandboxRepository.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.lifecycleManager.updateLastActivity).not.toHaveBeenCalled();
    expect(h.lifecycleManager.scheduleInactivityCheck).not.toHaveBeenCalled();
    expect(h.submitted).toEqual([]);
    expect(h.processMessageQueue).not.toHaveBeenCalled();
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).not.toContain("sandbox_status");
  });

  it("pumps the queue when the bridge of an already-ready sandbox reconnects", async () => {
    // A bridge restart or a hibernation wake: the sandbox never stopped
    // being ready, so a prompt queued while the socket was down must not
    // wait for a user action. Readiness itself is still not re-published.
    const h = createHarness({ sandbox: await sandboxRow({ status: "ready" }) });
    h.wsManager.getReadySandboxSocket.mockReturnValue(socket);

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(h.submitted).toEqual(["message_queue.process"]);
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.sandboxRepository.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).not.toContain("sandbox_status");
  });

  it("arms the boot liveness check before adopting the socket", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });
    const order: string[] = [];
    h.lifecycleManager.scheduleDisconnectCheck.mockImplementation(async () => {
      order.push("schedule");
    });
    h.wsManager.acceptAndSetSandboxSocket.mockImplementation(() => {
      order.push("accept");
      return { replaced: false };
    });

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(order).toEqual(["schedule", "accept"]);
  });

  it("commits nothing when the liveness check cannot be armed", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });
    h.lifecycleManager.scheduleDisconnectCheck.mockRejectedValue(new Error("alarm unavailable"));

    await expect((await accepted(h, sandboxUpgrade())).attach(socket)).rejects.toThrow(
      "alarm unavailable"
    );

    expect(h.wsManager.acceptAndSetSandboxSocket).not.toHaveBeenCalled();
    expect(h.sandboxRepository.updateSandboxHeartbeat).not.toHaveBeenCalled();
    expect(h.lifecycleManager.onSandboxConnected).not.toHaveBeenCalled();
    expect(h.lifecycleManager.onSandboxSocketAttached).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.submitted).toEqual([]);
  });

  it("closes the socket and commits nothing when the generation rotated while the liveness check was arming", async () => {
    // A cancel or a replacement spawn can rewrite the row while the alarm
    // write is pending. The socket that was admitted belongs to the old
    // generation; adopting it would hand the new row a stranger's bridge.
    const original = await sandboxRow({ status: "spawning" });
    const h = createHarness({ sandbox: original });
    const decision = await accepted(h, sandboxUpgrade());
    h.lifecycleManager.scheduleDisconnectCheck.mockImplementation(async () => {
      h.sandboxRepository.getSandbox.mockReturnValue({
        ...original,
        modal_sandbox_id: "sb-replacement",
        created_at: 9000,
      });
    });

    await decision.attach(socket);

    expect(h.wsManager.close).toHaveBeenCalledWith(socket, 4003, "Sandbox generation replaced");
    expect(h.wsManager.acceptAndSetSandboxSocket).not.toHaveBeenCalled();
    expect(h.sandboxRepository.updateSandboxHeartbeat).not.toHaveBeenCalled();
    expect(h.lifecycleManager.onSandboxConnected).not.toHaveBeenCalled();
    expect(h.lifecycleManager.onSandboxSocketAttached).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.submitted).toEqual([]);
    expect(h.log.warn).toHaveBeenCalledWith(
      "ws.connect",
      expect.objectContaining({ ws_type: "sandbox", outcome: "generation_replaced" })
    );
  });

  it("stamps the heartbeat only once the liveness check is armed", async () => {
    // The heartbeat is the "has connected" mark the connect watchdog stands
    // down for; a generation whose socket was never adopted must not earn it.
    const h = createHarness({ sandbox: await sandboxRow({ status: "spawning" }) });
    const order: string[] = [];
    h.lifecycleManager.scheduleDisconnectCheck.mockImplementation(async () => {
      order.push("schedule");
    });
    h.sandboxRepository.updateSandboxHeartbeat.mockImplementation(() => {
      order.push("heartbeat");
    });

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(order).toEqual(["schedule", "heartbeat"]);
  });

  it("withholds the access broadcast while provider startup is still persisting", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });
    h.lifecycleManager.isProviderStartupPending.mockReturnValue(true);

    await (await accepted(h, sandboxUpgrade())).attach(socket);

    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("passes the presented sandbox id through, or undefined when the bridge sent none", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ modal_sandbox_id: null }) });

    await (
      await accepted(h, upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: null }))
    ).attach(socket);

    expect(h.wsManager.acceptAndSetSandboxSocket).toHaveBeenCalledWith(socket, undefined);
  });

  it("attaches exactly once", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });
    const decision = await accepted(h, sandboxUpgrade());

    await decision.attach(socket);

    await expect(decision.attach({} as WebSocket)).rejects.toThrow("already attached");
    expect(h.wsManager.acceptAndSetSandboxSocket).toHaveBeenCalledOnce();
  });
});
