/**
 * Session Rivet Actor.
 *
 * Replaces the Cloudflare Durable Object + per-DO SQLite database.
 * All session state is held in-memory by the actor and automatically
 * persisted by Rivet's state management.
 *
 * The actor handles:
 * - Session lifecycle (create, archive, unarchive)
 * - Prompt queuing and processing
 * - Sandbox event ingestion and storage
 * - Real-time WebSocket broadcasting to connected clients
 * - Sandbox spawn/lifecycle coordination
 * - PR creation delegation
 */

import { actor, type ActorContext, type Connection } from "rivetkit";
import { v4 as uuidv4 } from "uuid";
import type {
  SessionStatus,
  SandboxStatus,
  SandboxEvent,
  ServerMessage,
  SessionState,
  ParticipantPresence,
  MessageSource,
  MessageStatus,
} from "../types";
import { shouldPersistEvent, shouldBroadcastEvent } from "../realtime/events";
import { createLogger, parseLogLevel } from "../logger";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
} from "../sandbox/lifecycle/decisions";
import { hashToken } from "../auth/crypto";

const log = createLogger("session-actor");

// ==================== State Types ====================

export interface ParticipantData {
  id: string;
  userId: string;
  githubLogin: string | null;
  githubName: string | null;
  role: "owner" | "member";
  joinedAt: number;
}

export interface MessageData {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  status: MessageStatus;
  model?: string;
  reasoningEffort?: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface EventData {
  id: string;
  type: string;
  data: Record<string, unknown>;
  messageId: string | null;
  sandboxId: string | null;
  createdAt: number;
}

export interface ArtifactData {
  id: string;
  type: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface SandboxData {
  sandboxId: string;
  status: SandboxStatus;
  providerObjectId: string | null;
  authTokenHash: string | null;
  snapshotImageId: string | null;
  createdAt: number;
  lastActivity: number | null;
  lastHeartbeat: number | null;
  lastSpawnError: string | null;
  lastSpawnErrorAt: number | null;
}

export interface SessionActorState {
  session: {
    id: string;
    sessionName: string | null;
    title: string | null;
    repoOwner: string;
    repoName: string;
    repoId: number | null;
    repoDefaultBranch: string;
    branchName: string | null;
    baseSha: string | null;
    currentSha: string | null;
    opencodeSessionId: string | null;
    model: string;
    reasoningEffort: string | null;
    status: SessionStatus;
    createdAt: number;
    updatedAt: number;
  } | null;
  participants: Record<string, ParticipantData>;
  messages: MessageData[];
  events: EventData[];
  artifacts: ArtifactData[];
  sandbox: SandboxData | null;
  // Circuit breaker
  spawnFailureCount: number;
  lastSpawnFailure: number | null;
  // Spawn tracking
  isSpawning: boolean;
  // Connection tracking: connectionId -> { participantId, userId, ... }
  connections: Record<string, { participantId: string; userId: string; authenticated: boolean }>;
}

// ==================== Input/Output Types ====================

export interface InitInput {
  sessionId: string;
  repoOwner: string;
  repoName: string;
  repoDefaultBranch?: string;
  repoId?: number;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  ownerId?: string;
  ownerLogin?: string;
  ownerName?: string;
}

export interface EnqueuePromptInput {
  authorId: string;
  content: string;
  source: MessageSource;
  model?: string;
  reasoningEffort?: string;
}

export interface EnqueuePromptResult {
  messageId: string;
  position: number;
}

export interface GetEventsInput {
  cursor?: string;
  limit?: number;
  types?: string[];
}

export interface GetEventsResult {
  events: EventData[];
  cursor: string | null;
  hasMore: boolean;
}

export interface GenerateWsTokenResult {
  token: string;
  expiresAt: number;
}

export interface CreatePRInput {
  title: string;
  body?: string;
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
}

// ==================== Actor Definition ====================

function createInitialState(): SessionActorState {
  return {
    session: null,
    participants: {},
    messages: [],
    events: [],
    artifacts: [],
    sandbox: null,
    spawnFailureCount: 0,
    lastSpawnFailure: null,
    isSpawning: false,
    connections: {},
  };
}

export const sessionActor = actor({
  state: createInitialState(),

  actions: {
    /**
     * Initialize the session with required data.
     * Called once after actor creation.
     */
    init: (c, input: InitInput) => {
      const now = Date.now();

      if (c.state.session) {
        // Already initialized -- return existing state
        return { status: "already_initialized", sessionId: c.state.session.id };
      }

      c.state.session = {
        id: input.sessionId,
        sessionName: null,
        title: input.title ?? null,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        repoId: input.repoId ?? null,
        repoDefaultBranch: input.repoDefaultBranch ?? "main",
        branchName: null,
        baseSha: null,
        currentSha: null,
        opencodeSessionId: null,
        model: input.model ?? "claude-sonnet-4-5",
        reasoningEffort: input.reasoningEffort ?? null,
        status: "created",
        createdAt: now,
        updatedAt: now,
      };

      c.state.sandbox = {
        sandboxId: uuidv4(),
        status: "pending",
        providerObjectId: null,
        authTokenHash: null,
        snapshotImageId: null,
        createdAt: now,
        lastActivity: null,
        lastHeartbeat: null,
        lastSpawnError: null,
        lastSpawnErrorAt: null,
      };

      // Add owner as first participant
      if (input.ownerId) {
        const participantId = uuidv4();
        c.state.participants[participantId] = {
          id: participantId,
          userId: input.ownerId,
          githubLogin: input.ownerLogin ?? null,
          githubName: input.ownerName ?? null,
          role: "owner",
          joinedAt: now,
        };
      }

      return { status: "initialized", sessionId: input.sessionId };
    },

    /**
     * Get current session state for client subscription.
     */
    getState: (c): SessionState | null => {
      const session = c.state.session;
      if (!session) return null;

      const pendingMessages = c.state.messages.filter((m) => m.status === "pending" || m.status === "processing");

      return {
        id: session.id,
        title: session.title,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        branchName: session.branchName,
        status: session.status,
        sandboxStatus: c.state.sandbox?.status ?? "pending",
        messageCount: c.state.messages.length,
        createdAt: session.createdAt,
        model: session.model,
        reasoningEffort: session.reasoningEffort ?? undefined,
        isProcessing: pendingMessages.length > 0,
      };
    },

    /**
     * Get the full session details (for API response).
     */
    getSessionDetails: (c) => {
      const session = c.state.session;
      if (!session) return null;

      return {
        id: session.id,
        title: session.title,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        repoDefaultBranch: session.repoDefaultBranch,
        branchName: session.branchName,
        baseSha: session.baseSha,
        currentSha: session.currentSha,
        opencodeSessionId: session.opencodeSessionId,
        status: session.status,
        sandboxStatus: c.state.sandbox?.status ?? "pending",
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    },

    /**
     * Archive the session.
     */
    archive: (c) => {
      if (!c.state.session) return { success: false, error: "not_initialized" };
      c.state.session.status = "archived";
      c.state.session.updatedAt = Date.now();
      broadcastToAll(c, { type: "session_status", status: "archived" });
      return { success: true };
    },

    /**
     * Unarchive the session.
     */
    unarchive: (c) => {
      if (!c.state.session) return { success: false, error: "not_initialized" };
      if (c.state.session.status !== "archived") {
        return { success: false, error: "not_archived" };
      }
      c.state.session.status = "active";
      c.state.session.updatedAt = Date.now();
      broadcastToAll(c, { type: "session_status", status: "active" });
      return { success: true };
    },

    /**
     * Enqueue a prompt for processing.
     */
    enqueuePrompt: (c, data: EnqueuePromptInput): EnqueuePromptResult => {
      if (!c.state.session) throw new Error("Session not initialized");

      const messageId = uuidv4();
      const now = Date.now();

      const message: MessageData = {
        id: messageId,
        authorId: data.authorId,
        content: data.content,
        source: data.source,
        status: "pending",
        model: data.model,
        reasoningEffort: data.reasoningEffort,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      };

      c.state.messages.push(message);

      // Update session model if specified
      if (data.model) {
        c.state.session.model = data.model;
      }
      if (data.reasoningEffort) {
        c.state.session.reasoningEffort = data.reasoningEffort;
      }

      // Mark session as active on first prompt
      if (c.state.session.status === "created") {
        c.state.session.status = "active";
      }
      c.state.session.updatedAt = now;

      // Calculate queue position
      const pendingMessages = c.state.messages.filter((m) => m.status === "pending");
      const position = pendingMessages.length;

      // Store the user_message as an event for replay
      const userEvent: EventData = {
        id: uuidv4(),
        type: "user_message",
        data: {
          content: data.content,
          messageId,
          author: { participantId: data.authorId },
        },
        messageId,
        sandboxId: null,
        createdAt: now,
      };
      c.state.events.push(userEvent);

      // Broadcast to all clients
      broadcastToAll(c, { type: "prompt_queued", messageId, position });

      return { messageId, position };
    },

    /**
     * Stop the current execution.
     */
    stop: (c) => {
      if (!c.state.session) return { success: false };

      // Mark any processing messages as completed
      for (const msg of c.state.messages) {
        if (msg.status === "processing") {
          msg.status = "completed";
          msg.completedAt = Date.now();
        }
      }

      broadcastToAll(c, { type: "processing_status", isProcessing: false });
      return { success: true };
    },

    /**
     * Get paginated events.
     */
    getEvents: (c, opts: GetEventsInput): GetEventsResult => {
      const limit = opts.limit ?? 50;
      let events = c.state.events;

      // Filter by types if specified
      if (opts.types && opts.types.length > 0) {
        const typeSet = new Set(opts.types);
        events = events.filter((e) => typeSet.has(e.type));
      }

      // Apply cursor (events after the cursor timestamp+id)
      let startIdx = 0;
      if (opts.cursor) {
        const cursorIdx = events.findIndex((e) => e.id === opts.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const slice = events.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < events.length;
      const nextCursor = slice.length > 0 ? slice[slice.length - 1].id : null;

      return {
        events: slice,
        cursor: hasMore ? nextCursor : null,
        hasMore,
      };
    },

    /**
     * Get messages, optionally filtered by status.
     */
    getMessages: (c, opts?: { status?: string }) => {
      let messages = c.state.messages;
      if (opts?.status) {
        messages = messages.filter((m) => m.status === opts.status);
      }
      return messages;
    },

    /**
     * Get artifacts.
     */
    getArtifacts: (c) => {
      return c.state.artifacts;
    },

    /**
     * Get participants.
     */
    getParticipants: (c) => {
      return Object.values(c.state.participants);
    },

    /**
     * Add a participant.
     */
    addParticipant: (c, data: { userId: string; githubLogin?: string; githubName?: string; role?: "owner" | "member" }) => {
      // Check if already a participant
      const existing = Object.values(c.state.participants).find((p) => p.userId === data.userId);
      if (existing) return { participantId: existing.id, alreadyExists: true };

      const participantId = uuidv4();
      c.state.participants[participantId] = {
        id: participantId,
        userId: data.userId,
        githubLogin: data.githubLogin ?? null,
        githubName: data.githubName ?? null,
        role: data.role ?? "member",
        joinedAt: Date.now(),
      };

      return { participantId, alreadyExists: false };
    },

    /**
     * Handle events from a sandbox pod.
     *
     * This is the main ingestion path for sandbox events (tokens, tool calls, etc.)
     */
    handleSandboxEvent: (c, event: SandboxEvent) => {
      if (!c.state.session) return;

      const now = Date.now();

      // Update last activity on sandbox
      if (c.state.sandbox) {
        c.state.sandbox.lastActivity = now;
      }

      // Handle heartbeat specially -- update tracking but don't persist
      if (event.type === "heartbeat") {
        if (c.state.sandbox) {
          c.state.sandbox.lastHeartbeat = now;
          if (event.status) {
            // Update sandbox status from heartbeat if meaningful
            const status = event.status as SandboxStatus;
            if (status === "ready" || status === "running") {
              c.state.sandbox.status = status;
            }
          }
        }
        // Broadcast heartbeat to clients but don't persist
        broadcastToAll(c, { type: "sandbox_event", event });
        return;
      }

      // Persist event
      if (shouldPersistEvent(event.type)) {
        const eventData: EventData = {
          id: uuidv4(),
          type: event.type,
          data: event as unknown as Record<string, unknown>,
          messageId: "messageId" in event ? (event as { messageId: string }).messageId : null,
          sandboxId: "sandboxId" in event ? (event as { sandboxId: string }).sandboxId : null,
          createdAt: event.timestamp ?? now,
        };
        c.state.events.push(eventData);
      }

      // Handle execution_complete -- mark message as completed
      if (event.type === "execution_complete") {
        const msgId = (event as { messageId: string }).messageId;
        const message = c.state.messages.find((m) => m.id === msgId);
        if (message) {
          message.status = (event as { success: boolean }).success ? "completed" : "failed";
          message.completedAt = now;
        }
        broadcastToAll(c, { type: "processing_status", isProcessing: false });
      }

      // Handle git_sync -- update branch/sha info
      if (event.type === "git_sync" && c.state.session) {
        const syncEvent = event as { status: string; sha?: string };
        if (syncEvent.sha) {
          c.state.session.currentSha = syncEvent.sha;
          if (!c.state.session.baseSha) {
            c.state.session.baseSha = syncEvent.sha;
          }
        }
      }

      // Handle artifact events
      if (event.type === "artifact") {
        const artifactEvent = event as { artifactType: string; url: string; metadata?: Record<string, unknown> };
        const artifact: ArtifactData = {
          id: uuidv4(),
          type: artifactEvent.artifactType,
          url: artifactEvent.url,
          metadata: artifactEvent.metadata ?? null,
          createdAt: now,
        };
        c.state.artifacts.push(artifact);
        broadcastToAll(c, {
          type: "artifact_created",
          artifact: { id: artifact.id, type: artifact.type, url: artifact.url ?? "" },
        });
      }

      // Handle push_complete -- update branch name
      if (event.type === "push_complete" && c.state.session) {
        const pushEvent = event as { branchName: string };
        c.state.session.branchName = pushEvent.branchName;
      }

      // Broadcast to all connected clients
      if (shouldBroadcastEvent(event.type)) {
        broadcastToAll(c, { type: "sandbox_event", event });
      }

      c.state.session.updatedAt = now;
    },

    /**
     * Update sandbox status.
     */
    updateSandboxStatus: (c, data: { status: SandboxStatus; error?: string }) => {
      if (!c.state.sandbox) return;

      c.state.sandbox.status = data.status;

      if (data.error) {
        c.state.sandbox.lastSpawnError = data.error;
        c.state.sandbox.lastSpawnErrorAt = Date.now();
      }

      // Broadcast status change
      broadcastToAll(c, { type: "sandbox_status", status: data.status });

      if (data.status === "ready") {
        broadcastToAll(c, { type: "sandbox_ready" });
      } else if (data.status === "failed" && data.error) {
        broadcastToAll(c, { type: "sandbox_error", error: data.error });
      }
    },

    /**
     * Record a spawn failure for the circuit breaker.
     */
    recordSpawnFailure: (c) => {
      c.state.spawnFailureCount++;
      c.state.lastSpawnFailure = Date.now();
      c.state.isSpawning = false;
    },

    /**
     * Reset the circuit breaker after a successful spawn.
     */
    resetCircuitBreaker: (c) => {
      c.state.spawnFailureCount = 0;
      c.state.lastSpawnFailure = null;
      c.state.isSpawning = false;
    },

    /**
     * Get spawn decision -- determines if a sandbox should be spawned.
     */
    getSpawnDecision: (c) => {
      if (!c.state.sandbox) return { action: "skip", reason: "no sandbox configured" };

      // Check circuit breaker
      const cbState = {
        failureCount: c.state.spawnFailureCount,
        lastFailureTime: c.state.lastSpawnFailure ?? 0,
      };
      const cbDecision = evaluateCircuitBreaker(cbState, DEFAULT_CIRCUIT_BREAKER_CONFIG, Date.now());

      if (!cbDecision.shouldProceed) {
        return { action: "skip", reason: `circuit breaker open, wait ${cbDecision.waitTimeMs}ms` };
      }

      if (cbDecision.shouldReset) {
        c.state.spawnFailureCount = 0;
        c.state.lastSpawnFailure = null;
      }

      // Check spawn decision
      const sandboxState = {
        status: c.state.sandbox.status,
        createdAt: c.state.sandbox.createdAt,
        snapshotImageId: c.state.sandbox.snapshotImageId,
        hasActiveWebSocket: false, // Actor manages connections differently
      };

      return evaluateSpawnDecision(sandboxState, DEFAULT_SPAWN_CONFIG, Date.now(), c.state.isSpawning);
    },

    /**
     * Mark spawn as in progress.
     */
    setSpawning: (c, data: { sandboxId: string; authTokenHash: string }) => {
      c.state.isSpawning = true;
      if (c.state.sandbox) {
        c.state.sandbox.sandboxId = data.sandboxId;
        c.state.sandbox.authTokenHash = data.authTokenHash;
        c.state.sandbox.status = "spawning";
        c.state.sandbox.createdAt = Date.now();
      }
      broadcastToAll(c, { type: "sandbox_spawning" });
    },

    /**
     * Generate a WebSocket authentication token for a participant.
     */
    generateWsToken: async (c, data: { participantId: string }): Promise<GenerateWsTokenResult> => {
      const token = uuidv4() + "-" + uuidv4();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min expiry

      return { token, expiresAt };
    },

    /**
     * Verify a sandbox authentication token.
     */
    verifySandboxToken: async (c, data: { token: string; sandboxId: string }): Promise<boolean> => {
      if (!c.state.sandbox) return false;
      if (c.state.sandbox.sandboxId !== data.sandboxId) return false;
      if (!c.state.sandbox.authTokenHash) return false;

      const hash = await hashToken(data.token);
      return hash === c.state.sandbox.authTokenHash;
    },

    /**
     * Get sandbox info for spawn operations.
     */
    getSandboxInfo: (c) => {
      if (!c.state.session || !c.state.sandbox) return null;

      return {
        sessionId: c.state.session.id,
        repoOwner: c.state.session.repoOwner,
        repoName: c.state.session.repoName,
        repoId: c.state.session.repoId,
        model: c.state.session.model,
        opencodeSessionId: c.state.session.opencodeSessionId,
        sandboxId: c.state.sandbox.sandboxId,
        sandboxStatus: c.state.sandbox.status,
        snapshotImageId: c.state.sandbox.snapshotImageId,
      };
    },

    /**
     * Update the session title.
     */
    updateTitle: (c, data: { title: string }) => {
      if (!c.state.session) return;
      c.state.session.title = data.title;
      c.state.session.updatedAt = Date.now();
    },

    /**
     * Update the OpenCode session ID (set after sandbox connects).
     */
    updateOpencodeSessionId: (c, data: { opencodeSessionId: string }) => {
      if (!c.state.session) return;
      c.state.session.opencodeSessionId = data.opencodeSessionId;
    },

    /**
     * Update sandbox provider object ID (K8s job name, etc.)
     */
    updateProviderObjectId: (c, data: { providerObjectId: string }) => {
      if (!c.state.sandbox) return;
      c.state.sandbox.providerObjectId = data.providerObjectId;
    },
  },

  /**
   * Handle new WebSocket connection.
   *
   * Clients connect and send a "subscribe" message with an auth token.
   * The actor validates the token and registers the connection.
   */
  onConnect: (c: ActorContext<SessionActorState>, conn: Connection) => {
    const connId = conn.id;
    c.state.connections[connId] = {
      participantId: "",
      userId: "",
      authenticated: false,
    };
    log.info("Client connected", { connectionId: connId });
  },

  onDisconnect: (c: ActorContext<SessionActorState>, conn: Connection) => {
    const connId = conn.id;
    const connData = c.state.connections[connId];

    if (connData?.authenticated && connData.userId) {
      // Broadcast presence leave
      broadcastToAll(c, { type: "presence_leave", userId: connData.userId });
    }

    delete c.state.connections[connId];
    log.info("Client disconnected", { connectionId: connId });
  },

  options: {
    name: "session",
  },
});

// ==================== Helpers ====================

/**
 * Broadcast a message to all authenticated connections.
 */
function broadcastToAll(c: ActorContext<SessionActorState>, message: ServerMessage): void {
  const serialized = JSON.stringify(message);
  for (const conn of c.conns.values()) {
    const connData = c.state.connections[conn.id];
    if (connData?.authenticated) {
      try {
        conn.send(serialized);
      } catch {
        // Connection may have closed
      }
    }
  }
}

export type SessionActor = typeof sessionActor;
