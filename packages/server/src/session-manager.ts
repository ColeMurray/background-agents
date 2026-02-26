/**
 * Session manager — orchestrates the lifecycle of agent sessions.
 *
 * Replaces the Durable Object SessionDO. Manages:
 * - Prompt queue (FIFO)
 * - Sandbox (Docker container) lifecycle
 * - WebSocket connections (client + sandbox bridge)
 * - Event persistence and broadcast
 *
 * Each session has at most one sandbox container running at a time.
 */

import type { WebSocket } from "ws";
import type { SandboxEvent, SessionState, SandboxStatus } from "@background-agents/shared";
import { nanoid } from "nanoid";
import { Repository } from "./repository.js";
import { DockerManager } from "./docker.js";
import { WorktreeManager } from "./worktree.js";
import type { SessionRow } from "./repository.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 90_000; // 3x the 30s heartbeat interval
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;
const SERVER_PORT = parseInt(process.env.PORT || "8787", 10);

// ─── Connection registry ────────────────────────────────────────────────────

interface SessionConnections {
  clients: Set<WebSocket>;
  sandbox: WebSocket | null;
}

// ─── Singleton state ────────────────────────────────────────────────────────

const connections = new Map<string, SessionConnections>();
const inactivityTimers = new Map<string, NodeJS.Timeout>();
const heartbeatTimers = new Map<string, NodeJS.Timeout>();
const processingMessages = new Map<string, string>(); // sessionId -> messageId

let repo: Repository;
let dockerManager: DockerManager;
let worktreeManager: WorktreeManager;

export function initSessionManager(
  repository: Repository,
  docker: DockerManager,
  worktree: WorktreeManager
): void {
  repo = repository;
  dockerManager = docker;
  worktreeManager = worktree;
}

// ─── Connection management ──────────────────────────────────────────────────

function getConnections(sessionId: string): SessionConnections {
  let conns = connections.get(sessionId);
  if (!conns) {
    conns = { clients: new Set(), sandbox: null };
    connections.set(sessionId, conns);
  }
  return conns;
}

export function registerClientWs(sessionId: string, ws: WebSocket): void {
  getConnections(sessionId).clients.add(ws);
}

export function unregisterClientWs(sessionId: string, ws: WebSocket): void {
  const conns = connections.get(sessionId);
  if (conns) {
    conns.clients.delete(ws);
    if (conns.clients.size === 0 && !conns.sandbox) {
      connections.delete(sessionId);
    }
  }
}

export function registerSandboxWs(sessionId: string, ws: WebSocket): void {
  const conns = getConnections(sessionId);
  conns.sandbox = ws;
  startHeartbeatMonitor(sessionId);
}

export function unregisterSandboxWs(sessionId: string, ws: WebSocket): void {
  const conns = connections.get(sessionId);
  if (conns && conns.sandbox === ws) {
    conns.sandbox = null;
    stopHeartbeatMonitor(sessionId);
  }
}

function hasSandboxWs(sessionId: string): boolean {
  return connections.get(sessionId)?.sandbox !== null;
}

// ─── Broadcasting ───────────────────────────────────────────────────────────

function broadcastToClients(sessionId: string, message: object): void {
  const conns = connections.get(sessionId);
  if (!conns) return;
  const payload = JSON.stringify(message);
  for (const ws of conns.clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function sendToSandbox(sessionId: string, message: object): boolean {
  const conns = connections.get(sessionId);
  if (!conns?.sandbox || conns.sandbox.readyState !== conns.sandbox.OPEN) {
    return false;
  }
  conns.sandbox.send(JSON.stringify(message));
  return true;
}

// ─── Client subscribe ───────────────────────────────────────────────────────

export function handleClientSubscribe(sessionId: string, ws: WebSocket): void {
  const session = repo.getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", code: "not_found", message: "Session not found" }));
    ws.close(4004, "Session not found");
    return;
  }

  registerClientWs(sessionId, ws);

  // Build session state
  const state: SessionState = {
    id: session.id,
    title: session.title,
    repoOwner: session.repo_name, // Local mode: repo_name serves as repoOwner
    repoName: session.repo_name,
    branchName: session.branch_name,
    status: session.status,
    sandboxStatus: session.sandbox_status as SandboxStatus,
    messageCount: repo.getMessageCount(sessionId),
    createdAt: session.created_at,
    model: session.model,
    reasoningEffort: session.reasoning_effort ?? undefined,
    isProcessing: processingMessages.has(sessionId),
  };

  // Get recent events for replay
  const events = repo.getEventsForReplay(sessionId, 500);
  const replayEvents: SandboxEvent[] = events.map((e) => JSON.parse(e.data));

  const hasMore = events.length >= 500;
  const cursor = events.length > 0 ? { timestamp: events[0].created_at, id: events[0].id } : null;

  ws.send(
    JSON.stringify({
      type: "subscribed",
      sessionId,
      state,
      participantId: "local-user",
      replay: { events: replayEvents, hasMore, cursor },
      spawnError: session.last_spawn_error ?? null,
    })
  );
}

// ─── Client prompt ──────────────────────────────────────────────────────────

export async function handleClientPrompt(
  sessionId: string,
  data: { content: string; model?: string; reasoningEffort?: string }
): Promise<void> {
  const session = repo.getSession(sessionId);
  if (!session) return;

  // Create message
  const messageId = `msg_${nanoid(16)}`;
  repo.createMessage({
    id: messageId,
    sessionId,
    content: data.content,
    model: data.model,
    reasoningEffort: data.reasoningEffort,
  });

  // Write a user_message event
  const userEvent: SandboxEvent = {
    type: "user_message",
    sandboxId: session.container_id || sessionId,
    timestamp: Date.now() / 1000,
    messageId,
    content: data.content,
  };
  repo.createEvent({
    id: `user:${messageId}`,
    sessionId,
    type: "user_message",
    dataJson: JSON.stringify(userEvent),
    messageId,
  });
  broadcastToClients(sessionId, { type: "sandbox_event", event: userEvent });

  // Notify client
  broadcastToClients(sessionId, { type: "prompt_queued", messageId, position: 1 });

  // Activate session if needed
  if (session.status === "created") {
    repo.updateSessionStatus(sessionId, "active");
  }

  // Update model if specified
  if (data.model) {
    repo.updateSessionModel(sessionId, data.model);
  }

  // Process the message queue
  await processMessageQueue(sessionId);
}

// ─── Message queue processing ───────────────────────────────────────────────

async function processMessageQueue(sessionId: string): Promise<void> {
  // Skip if already processing a message
  if (processingMessages.has(sessionId)) return;

  const message = repo.getNextPendingMessage(sessionId);
  if (!message) return;

  // If no sandbox is connected, spawn one
  if (!hasSandboxWs(sessionId)) {
    broadcastToClients(sessionId, { type: "sandbox_spawning" });
    await spawnSandbox(sessionId);
    // The queue will resume when the sandbox connects and sends 'ready'
    return;
  }

  // Mark message as processing
  processingMessages.set(sessionId, message.id);
  repo.updateMessageToProcessing(message.id);
  broadcastToClients(sessionId, { type: "processing_status", isProcessing: true });

  // Update activity
  repo.updateSessionLastActivity(sessionId, Date.now());
  resetInactivityTimer(sessionId);

  // Resolve model
  const session = repo.getSession(sessionId);
  const model = message.model || session?.model || "anthropic/claude-sonnet-4-6";
  const reasoningEffort = message.reasoning_effort || session?.reasoning_effort || undefined;

  // Send prompt to sandbox
  const sent = sendToSandbox(sessionId, {
    type: "prompt",
    messageId: message.id,
    content: message.content,
    model,
    reasoningEffort,
    author: {
      userId: "local-user",
      scmName: null,
      scmEmail: null,
    },
    ...(message.attachments ? { attachments: JSON.parse(message.attachments) } : {}),
  });

  if (!sent) {
    // Sandbox disconnected mid-send, revert to pending
    processingMessages.delete(sessionId);
    repo.updateMessageCompletion(message.id, "failed");
    broadcastToClients(sessionId, { type: "processing_status", isProcessing: false });
    // Try to spawn a new sandbox
    await spawnSandbox(sessionId);
  }
}

// ─── Sandbox lifecycle ──────────────────────────────────────────────────────

async function spawnSandbox(sessionId: string): Promise<void> {
  const session = repo.getSession(sessionId);
  if (!session) return;

  // Circuit breaker: don't spawn if too many recent failures
  if (session.spawn_failure_count >= 3) {
    const cooldown = Math.min(60_000, 5_000 * Math.pow(2, session.spawn_failure_count));
    const timeSinceLastFailure = Date.now() - (session.last_spawn_failure || 0);
    if (timeSinceLastFailure < cooldown) {
      broadcastToClients(sessionId, {
        type: "sandbox_error",
        error: `Spawn failed ${session.spawn_failure_count} times. Retrying in ${Math.ceil((cooldown - timeSinceLastFailure) / 1000)}s.`,
      });
      return;
    }
  }

  // Skip if already spawning or running
  if (
    session.sandbox_status === "spawning" ||
    (session.container_id && (await dockerManager.isRunning(session.container_id)))
  ) {
    return;
  }

  repo.updateSessionSandboxStatus(sessionId, "spawning");
  broadcastToClients(sessionId, { type: "sandbox_spawning" });

  try {
    // Create worktree if needed
    const worktreePath = await worktreeManager.create(
      sessionId,
      session.repo_path,
      session.base_branch
    );

    // Create Docker container
    const { containerId } = await dockerManager.createSandbox({
      sessionId,
      worktreePath,
      serverPort: SERVER_PORT,
    });

    repo.updateSessionContainer(sessionId, containerId, worktreePath);
    repo.updateSessionSandboxStatus(sessionId, "ready");
    repo.resetSpawnFailures(sessionId);
    repo.updateSessionSpawnError(sessionId, null);

    console.log(`[session] Spawned sandbox for session ${sessionId}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[session] Failed to spawn sandbox for ${sessionId}:`, msg);

    repo.updateSessionSandboxStatus(sessionId, "failed");
    repo.incrementSpawnFailure(sessionId);
    repo.updateSessionSpawnError(sessionId, msg);

    broadcastToClients(sessionId, {
      type: "sandbox_error",
      error: msg,
    });
  }
}

// ─── Sandbox event handling ─────────────────────────────────────────────────

export async function handleSandboxEvent(sessionId: string, event: SandboxEvent): Promise<void> {
  const session = repo.getSession(sessionId);
  if (!session) return;

  // Update heartbeat
  if (event.type === "heartbeat") {
    repo.updateSessionHeartbeat(sessionId, Date.now());
    return;
  }

  if (event.type === "ready") {
    repo.updateSessionSandboxStatus(sessionId, "ready");
    broadcastToClients(sessionId, { type: "sandbox_ready" });

    // If the sandbox sent an OpenCode session ID, store it
    if (
      event.metadata &&
      typeof event.metadata === "object" &&
      "opencodeSessionId" in event.metadata
    ) {
      repo.updateSessionOpencodeId(sessionId, event.metadata.opencodeSessionId as string);
    }

    // Resume processing the message queue now that sandbox is connected
    await processMessageQueue(sessionId);
    return;
  }

  // Update activity
  repo.updateSessionLastActivity(sessionId, Date.now());
  resetInactivityTimer(sessionId);

  // Determine event ID and persistence strategy
  let eventId: string;
  if (event.type === "token" && event.messageId) {
    // Upsert token events (only keep latest cumulative text)
    eventId = `token:${event.messageId}`;
    repo.upsertEvent({
      id: eventId,
      sessionId,
      type: event.type,
      dataJson: JSON.stringify(event),
      messageId: event.messageId ?? null,
    });
  } else if (event.type === "execution_complete" && event.messageId) {
    eventId = `exec:${event.messageId}`;
    repo.upsertEvent({
      id: eventId,
      sessionId,
      type: event.type,
      dataJson: JSON.stringify(event),
      messageId: event.messageId ?? null,
    });

    // Complete the message
    const currentMsgId = processingMessages.get(sessionId);
    if (currentMsgId) {
      repo.updateMessageCompletion(currentMsgId, event.success !== false ? "completed" : "failed");
      processingMessages.delete(sessionId);
      broadcastToClients(sessionId, { type: "processing_status", isProcessing: false });
    }

    // Process next message in queue
    setImmediate(() => processMessageQueue(sessionId));
  } else if (event.type === "push_complete") {
    eventId = `evt_${nanoid(12)}`;
    repo.createEvent({
      id: eventId,
      sessionId,
      type: event.type,
      dataJson: JSON.stringify(event),
      messageId: event.messageId ?? null,
    });

    // Create branch artifact
    if (event.metadata && typeof event.metadata === "object" && "branchName" in event.metadata) {
      const branchName = event.metadata.branchName as string;
      repo.updateSessionBranch(sessionId, branchName);
      repo.createArtifact({
        id: `art_${nanoid(12)}`,
        sessionId,
        type: "branch",
        url: null,
        metadata: JSON.stringify({ branchName }),
      });
    }
  } else if (
    event.type === "tool_call" ||
    event.type === "step_start" ||
    event.type === "step_finish" ||
    event.type === "error" ||
    event.type === "git_sync"
  ) {
    // Regular events — always insert
    eventId = `evt_${nanoid(12)}`;
    repo.createEvent({
      id: eventId,
      sessionId,
      type: event.type,
      dataJson: JSON.stringify(event),
      messageId: event.messageId ?? null,
    });
  } else {
    // Other event types (push_error, snapshot_ready, etc.)
    eventId = `evt_${nanoid(12)}`;
    repo.createEvent({
      id: eventId,
      sessionId,
      type: event.type,
      dataJson: JSON.stringify(event),
      messageId: event.messageId ?? null,
    });
  }

  // Broadcast to all connected clients
  broadcastToClients(sessionId, { type: "sandbox_event", event });
}

// ─── Stop execution ─────────────────────────────────────────────────────────

export function handleStopExecution(sessionId: string): void {
  const currentMsgId = processingMessages.get(sessionId);
  if (currentMsgId) {
    repo.updateMessageCompletion(currentMsgId, "failed");
    processingMessages.delete(sessionId);
    broadcastToClients(sessionId, { type: "processing_status", isProcessing: false });
  }

  // Tell sandbox to stop
  sendToSandbox(sessionId, { type: "stop" });
}

// ─── Session archive/unarchive ──────────────────────────────────────────────

export async function archiveSession(sessionId: string): Promise<void> {
  const session = repo.getSession(sessionId);
  if (!session) return;

  // Stop sandbox if running
  if (session.container_id) {
    await dockerManager.stopSandbox(session.container_id);
    await dockerManager.removeSandbox(session.container_id);
    repo.updateSessionContainer(sessionId, null, null);
  }

  repo.updateSessionStatus(sessionId, "archived");
  repo.updateSessionSandboxStatus(sessionId, "stopped");
  broadcastToClients(sessionId, { type: "session_status", status: "archived" });
}

export function unarchiveSession(sessionId: string): void {
  repo.updateSessionStatus(sessionId, "active");
  broadcastToClients(sessionId, { type: "session_status", status: "active" });
}

// ─── Inactivity timeout ────────────────────────────────────────────────────

function resetInactivityTimer(sessionId: string): void {
  const existing = inactivityTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    inactivityTimers.delete(sessionId);
    const session = repo.getSession(sessionId);
    if (!session || session.status === "archived") return;

    // Check if clients are still connected
    const conns = connections.get(sessionId);
    if (conns && conns.clients.size > 0) {
      // Extend for 5 more minutes
      resetInactivityTimer(sessionId);
      return;
    }

    console.log(`[session] Inactivity timeout for session ${sessionId}`);
    if (session.container_id) {
      await dockerManager.stopSandbox(session.container_id);
      repo.updateSessionSandboxStatus(sessionId, "stopped");
    }
  }, INACTIVITY_TIMEOUT_MS);

  inactivityTimers.set(sessionId, timer);
}

// ─── Heartbeat monitoring ───────────────────────────────────────────────────

function startHeartbeatMonitor(sessionId: string): void {
  stopHeartbeatMonitor(sessionId);

  const timer = setInterval(async () => {
    const session = repo.getSession(sessionId);
    if (!session) {
      stopHeartbeatMonitor(sessionId);
      return;
    }

    if (!session.last_heartbeat) return;

    const age = Date.now() - session.last_heartbeat;
    if (age > HEARTBEAT_TIMEOUT_MS) {
      console.warn(
        `[session] Sandbox heartbeat stale for session ${sessionId} (${Math.round(age / 1000)}s)`
      );
      repo.updateSessionSandboxStatus(sessionId, "failed");
      broadcastToClients(sessionId, {
        type: "sandbox_error",
        error: "Sandbox heartbeat lost. Container may have crashed.",
      });
      stopHeartbeatMonitor(sessionId);
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  heartbeatTimers.set(sessionId, timer);
}

function stopHeartbeatMonitor(sessionId: string): void {
  const timer = heartbeatTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(sessionId);
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export async function cleanupSession(sessionId: string): Promise<void> {
  // Clear timers
  const inactTimer = inactivityTimers.get(sessionId);
  if (inactTimer) clearTimeout(inactTimer);
  inactivityTimers.delete(sessionId);

  stopHeartbeatMonitor(sessionId);
  processingMessages.delete(sessionId);

  // Close WebSocket connections
  const conns = connections.get(sessionId);
  if (conns) {
    for (const ws of conns.clients) {
      ws.close(1000, "Session deleted");
    }
    if (conns.sandbox) {
      conns.sandbox.close(1000, "Session deleted");
    }
    connections.delete(sessionId);
  }
}

// ─── History pagination ─────────────────────────────────────────────────────

export function handleFetchHistory(
  sessionId: string,
  ws: WebSocket,
  cursor: { timestamp: number; id: string },
  limit?: number
): void {
  const pageSize = Math.min(limit || 200, 500);
  const { events, hasMore } = repo.getEventsHistoryPage(
    sessionId,
    cursor.timestamp,
    cursor.id,
    pageSize
  );

  const parsedEvents: SandboxEvent[] = events.map((e) => JSON.parse(e.data));
  const nextCursor =
    events.length > 0 ? { timestamp: events[0].created_at, id: events[0].id } : null;

  ws.send(
    JSON.stringify({
      type: "history_page",
      items: parsedEvents,
      hasMore,
      cursor: nextCursor,
    })
  );
}

// ─── Repo discovery ─────────────────────────────────────────────────────────

export async function discoverLocalRepos(
  searchDirs?: string[]
): Promise<Array<{ path: string; name: string; defaultBranch: string }>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const fs = await import("node:fs");
  const pathModule = await import("node:path");

  const dirs = searchDirs || [
    pathModule.join(process.env.HOME || "/tmp", "code"),
    pathModule.join(process.env.HOME || "/tmp", "projects"),
    pathModule.join(process.env.HOME || "/tmp", "dev"),
  ];

  const repos: Array<{ path: string; name: string; defaultBranch: string }> = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = pathModule.join(dir, entry.name);
      const gitPath = pathModule.join(fullPath, ".git");

      if (!fs.existsSync(gitPath)) continue;

      try {
        const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: fullPath,
        });
        repos.push({
          path: fullPath,
          name: entry.name,
          defaultBranch: stdout.trim(),
        });
      } catch {
        // Not a valid git repo or detached HEAD
        repos.push({
          path: fullPath,
          name: entry.name,
          defaultBranch: "main",
        });
      }
    }
  }

  return repos;
}
