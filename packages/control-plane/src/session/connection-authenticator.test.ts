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
    enforceAuthTimeout: ReturnType<typeof vi.fn>;
  };
  lifecycleManager: {
    isProviderStartupPending: ReturnType<typeof vi.fn>;
    onSandboxConnected: ReturnType<typeof vi.fn>;
    updateLastActivity: ReturnType<typeof vi.fn>;
    scheduleInactivityCheck: ReturnType<typeof vi.fn>;
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
    enforceAuthTimeout: vi.fn(async () => undefined),
  };
  const lifecycleManager = {
    isProviderStartupPending: vi.fn(() => false),
    onSandboxConnected: vi.fn(),
    updateLastActivity: vi.fn(),
    scheduleInactivityCheck: vi.fn(async () => undefined),
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

    const decision = await h.authenticator.authorize(upgradeRequest({}), h.log);

    expect(decision).toMatchObject({ kind: "accept", role: "client" });
    expect((decision as { wsId: string }).wsId).toMatch(/^ws-\d+-[a-z0-9]+$/);
    expect(h.sandboxRepository.getSandbox).not.toHaveBeenCalled();
  });

  it("accepts a sandbox upgrade carrying the presented sandbox id", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID }),
      h.log
    );

    expect(decision).toEqual({ kind: "accept", role: "sandbox", sandboxId: SANDBOX_ID });
  });

  it("rejects a wrong sandbox id with 403 before checking the token", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: "not-even-checked", sandboxId: "stale" }),
      h.log
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
      upgradeRequest({ sandbox: true, token: "wrong", sandboxId: SANDBOX_ID }),
      h.log
    );

    expect(await rejection(decision)).toEqual({
      status: 401,
      body: "Unauthorized: Invalid auth token",
    });
  });

  it("rejects a stopped sandbox with 401, not 410, when the token is invalid", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ status: "stopped" }) });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: "wrong", sandboxId: SANDBOX_ID }),
      h.log
    );

    expect((await rejection(decision)).status).toBe(401);
  });

  it("rejects a terminal session with 410 on a read taken after authentication", async () => {
    const h = createHarness({ sandbox: await sandboxRow(), session: sessionRow("cancelled") });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID }),
      h.log
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
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID }),
      h.log
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
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID }),
      h.log
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
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: SANDBOX_ID }),
      h.log
    );

    expect((await rejection(decision)).status).toBe(403);
  });

  it("accepts a bridge for a sandbox row that has no id yet", async () => {
    const h = createHarness({ sandbox: await sandboxRow({ modal_sandbox_id: null }) });

    const decision = await h.authenticator.authorize(
      upgradeRequest({ sandbox: true, token: TOKEN, sandboxId: "anything" }),
      h.log
    );

    expect(decision).toEqual({ kind: "accept", role: "sandbox", sandboxId: "anything" });
  });
});

describe("SessionConnectionAuthenticator.attach", () => {
  const socket = {} as WebSocket;

  it("registers a client socket and arms the authentication timeout", async () => {
    const h = createHarness({ sandbox: null });

    await h.authenticator.attach(socket, { kind: "accept", role: "client", wsId: "ws-1" }, h.log);

    expect(h.wsManager.acceptClientSocket).toHaveBeenCalledWith(socket, "ws-1");
    expect(h.submitted).toEqual(["websocket.enforce_auth_timeout"]);
    expect(h.wsManager.enforceAuthTimeout).toHaveBeenCalledWith(socket, "ws-1");
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("marks the sandbox ready, publishes access, arms the inactivity check, and drains the queue", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    await h.authenticator.attach(
      socket,
      { kind: "accept", role: "sandbox", sandboxId: SANDBOX_ID },
      h.log
    );

    expect(h.wsManager.acceptAndSetSandboxSocket).toHaveBeenCalledWith(socket, SANDBOX_ID);
    expect(h.lifecycleManager.onSandboxConnected).toHaveBeenCalledOnce();
    expect(h.sandboxRepository.updateSandboxStatus).toHaveBeenCalledWith("ready");
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).toEqual([
      "sandbox_status",
      "sandbox_access_changed",
    ]);
    expect(h.lifecycleManager.scheduleInactivityCheck).toHaveBeenCalledOnce();
    expect(h.submitted).toEqual(["message_queue.process"]);
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.log.info).toHaveBeenCalledWith(
      "ws.connect",
      expect.objectContaining({ outcome: "success", sandbox_id: SANDBOX_ID })
    );
  });

  it("withholds the access broadcast while provider startup is still persisting", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });
    h.lifecycleManager.isProviderStartupPending.mockReturnValue(true);

    await h.authenticator.attach(
      socket,
      { kind: "accept", role: "sandbox", sandboxId: SANDBOX_ID },
      h.log
    );

    expect(h.broadcast.mock.calls.map(([message]) => message.type)).toEqual(["sandbox_status"]);
  });

  it("passes an absent sandbox id through as undefined", async () => {
    const h = createHarness({ sandbox: await sandboxRow() });

    await h.authenticator.attach(
      socket,
      { kind: "accept", role: "sandbox", sandboxId: null },
      h.log
    );

    expect(h.wsManager.acceptAndSetSandboxSocket).toHaveBeenCalledWith(socket, undefined);
  });
});
