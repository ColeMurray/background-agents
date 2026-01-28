/**
 * Session Durable Object implementation.
 *
 * Each session gets its own Durable Object instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema";
import { generateId, decryptToken, hashToken } from "../auth/crypto";
import { generateInstallationToken, getGitHubAppConfig } from "../auth/github-app";
import { createSandboxManager, getSandboxBackend } from "../sandbox";
import { createPullRequest, getRepository } from "../auth/pr";
import { generateBranchName } from "@open-inspect/shared";
import type {
  Env,
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  ParticipantPresence,
} from "../types";
import type {
  SessionRow,
  ParticipantRow,
  MessageRow,
  EventRow,
  ArtifactRow,
  SandboxRow,
  SandboxCommand,
} from "./types";

/**
 * Message row with joined participant info for author attribution.
 */
type MessageWithParticipant = MessageRow & {
  participant_id: string | null;
  github_name: string | null;
  github_login: string | null;
};

/**
 * Build GitHub avatar URL from login.
 */
function getGitHubAvatarUrl(githubLogin: string | null | undefined): string | undefined {
  return githubLogin ? `https://github.com/${githubLogin}.png` : undefined;
}

/**
 * Valid model names for the LLM.
 */
const VALID_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"] as const;
type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Valid event types for filtering.
 * Includes both external types (from types.ts) and internal types used by the sandbox.
 */
const VALID_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "token",
  "error",
  "git_sync",
  "execution_complete",
  "heartbeat",
  "push_complete",
  "push_error",
] as const;

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

/**
 * Check if a model name is valid.
 */
function isValidModel(model: string): model is ValidModel {
  return VALID_MODELS.includes(model as ValidModel);
}

/**
 * Default model to use when none specified or invalid.
 */
const DEFAULT_MODEL: ValidModel = "claude-haiku-4-5";

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Extract provider and model from a model ID.
 * Models with "/" have embedded provider (kept for backward compatibility with existing sessions).
 * Models like "claude-haiku-4-5" use "anthropic" as default provider.
 */
function extractProviderAndModel(modelId: string): { provider: string; model: string } {
  if (modelId.includes("/")) {
    const [provider, ...modelParts] = modelId.split("/");
    return { provider, model: modelParts.join("/") };
  }
  return { provider: "anthropic", model: modelId };
}

/**
 * Route definition for internal API endpoints.
 */
interface InternalRoute {
  method: string;
  path: string;
  handler: (request: Request, url: URL) => Promise<Response> | Response;
}

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private clients: Map<WebSocket, ClientInfo>;
  private sandboxWs: WebSocket | null = null;
  private initialized = false;
  private isSpawningSandbox = false;
  // Track pending push operations by branch name
  private pendingPushResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  // Route table for internal API endpoints
  private readonly routes: InternalRoute[] = [
    { method: "POST", path: "/internal/init", handler: (req) => this.handleInit(req) },
    { method: "GET", path: "/internal/state", handler: () => this.handleGetState() },
    { method: "POST", path: "/internal/prompt", handler: (req) => this.handleEnqueuePrompt(req) },
    { method: "POST", path: "/internal/stop", handler: () => this.handleStop() },
    {
      method: "POST",
      path: "/internal/sandbox-event",
      handler: (req) => this.handleSandboxEvent(req),
    },
    { method: "GET", path: "/internal/participants", handler: () => this.handleListParticipants() },
    {
      method: "POST",
      path: "/internal/participants",
      handler: (req) => this.handleAddParticipant(req),
    },
    { method: "GET", path: "/internal/events", handler: (_, url) => this.handleListEvents(url) },
    { method: "GET", path: "/internal/artifacts", handler: () => this.handleListArtifacts() },
    {
      method: "GET",
      path: "/internal/messages",
      handler: (_, url) => this.handleListMessages(url),
    },
    { method: "POST", path: "/internal/create-pr", handler: (req) => this.handleCreatePR(req) },
    {
      method: "POST",
      path: "/internal/ws-token",
      handler: (req) => this.handleGenerateWsToken(req),
    },
    { method: "POST", path: "/internal/archive", handler: (req) => this.handleArchive(req) },
    { method: "POST", path: "/internal/unarchive", handler: (req) => this.handleUnarchive(req) },
    {
      method: "POST",
      path: "/internal/verify-sandbox-token",
      handler: (req) => this.handleVerifySandboxToken(req),
    },
  ];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.clients = new Map();
  }

  /**
   * Safely send a message over a WebSocket, handling errors and closed connections.
   * Returns true if the message was sent, false otherwise.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`[DO] Cannot send: WebSocket not open (state=${ws.readyState})`);
        return false;
      }
      const data = typeof message === "string" ? message : JSON.stringify(message);
      ws.send(data);
      return true;
    } catch (e) {
      console.log(`[DO] WebSocket send failed: ${e}`);
      return false;
    }
  }

  /**
   * Normalize branch name for comparison to handle case and whitespace differences.
   */
  private normalizeBranchName(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * Initialize the session with required data.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized();

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade (special case - header-based, not path-based)
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }

    // Match route from table
    const route = this.routes.find((r) => r.path === path && r.method === request.method);

    if (route) {
      return route.handler(request, url);
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request.
   */
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    console.log("DO: handleWebSocketUpgrade called");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      // Support both header-based auth (Modal/Python) and query param auth (Cloudflare/Bun)
      // Bun's WebSocket doesn't support headers in constructor, so we pass via query params
      const authHeader = request.headers.get("Authorization");
      const authToken = url.searchParams.get("token");
      const sandboxId = request.headers.get("X-Sandbox-ID") || url.searchParams.get("sandboxId");

      // Get expected values from DB
      const sandbox = this.getSandbox();
      const expectedToken = sandbox?.auth_token;
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      console.log(
        `[DO] Sandbox auth check: authHeader=${authHeader ? "present" : "missing"}, authToken=${authToken ? "present" : "missing"}, sandboxId=${sandboxId}, expectedSandboxId=${expectedSandboxId}, status=${sandbox?.status}`
      );

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout)
      if (sandbox?.status === "stopped" || sandbox?.status === "stale") {
        console.log(`[DO] Rejecting sandbox connection: sandbox is ${sandbox.status}`);
        return new Response("Sandbox is stopped", { status: 410 });
      }

      // Validate auth token
      const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authToken;

      if (!providedToken || providedToken !== expectedToken) {
        console.log("[DO] Sandbox auth failed: token mismatch");
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Validate sandbox ID (if we expect a specific one)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        console.log(
          `[DO] Sandbox auth failed: ID mismatch. Expected ${expectedSandboxId}, got ${sandboxId}`
        );
        return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
      }

      console.log("[DO] Sandbox auth passed");
    }

    try {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation support
      // Include sandbox ID in tags for identity validation after hibernation recovery
      // For client WebSockets, generate a unique ws_id for mapping recovery
      const sandboxId = request.headers.get("X-Sandbox-ID");
      let tags: string[];
      let wsId: string | undefined;
      if (isSandbox) {
        tags = ["sandbox", ...(sandboxId ? [`sid:${sandboxId}`] : [])];
      } else {
        // Generate unique ws_id for client WebSocket mapping
        wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        tags = [`wsid:${wsId}`];
      }
      this.ctx.acceptWebSocket(server, tags);
      console.log("DO: WebSocket accepted");

      if (isSandbox) {
        // Close any existing sandbox WebSocket to prevent duplicates
        const existingSandboxWs = this.getSandboxWebSocket();
        if (existingSandboxWs && existingSandboxWs !== server) {
          console.log("[DO] Closing existing sandbox WebSocket, new one connecting");
          try {
            existingSandboxWs.close(1000, "New sandbox connecting");
          } catch {
            // Ignore errors closing old WebSocket
          }
        }

        this.sandboxWs = server;
        this.isSpawningSandbox = false;
        this.updateSandboxStatus("ready");
        this.broadcast({ type: "sandbox_status", status: "ready" });

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.updateLastActivity(now);
        console.log(`[DO] Sandbox connected, scheduling inactivity check`);
        await this.scheduleInactivityCheck();

        // Process any pending messages now that sandbox is connected
        this.processMessageQueue();
      } else {
        // For client WebSockets, schedule authentication timeout check
        // This prevents resource abuse from connections that never authenticate
        if (wsId) {
          this.ctx.waitUntil(this.enforceAuthTimeout(server, wsId));
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      console.error("DO: WebSocket upgrade error:", error);
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    console.log("DO: webSocketMessage received");
    if (typeof message !== "string") return;

    const tags = this.ctx.getTags(ws);
    if (tags.includes("sandbox")) {
      await this.handleSandboxMessage(ws, message);
    } else {
      await this.handleClientMessage(ws, message);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const tags = this.ctx.getTags(ws);

    if (tags.includes("sandbox")) {
      this.sandboxWs = null;
      this.updateSandboxStatus("stopped");
    } else {
      const client = this.clients.get(ws);
      this.clients.delete(ws);

      if (client) {
        this.broadcast({ type: "presence_leave", userId: client.userId });
      }
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error("WebSocket error:", error);
    ws.close(1011, "Internal error");
  }

  /**
   * Enforce authentication timeout for client WebSockets.
   *
   * This method is called via ctx.waitUntil() after a client WebSocket is accepted.
   * It waits for the auth timeout period, then checks if the connection has been
   * authenticated (i.e., the client sent a valid 'subscribe' message).
   *
   * If the connection is still unauthenticated after the timeout, it is closed.
   * This prevents DoS attacks where attackers open many WebSocket connections
   * without ever completing the authentication handshake.
   *
   * @param ws - The WebSocket to check
   * @param wsId - The unique WebSocket ID for logging
   */
  private async enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void> {
    // Wait for the authentication timeout period
    await new Promise((resolve) => setTimeout(resolve, WS_AUTH_TIMEOUT_MS));

    // Check if the WebSocket is still open
    if (ws.readyState !== WebSocket.OPEN) {
      return; // Already closed, nothing to do
    }

    // Check if this WebSocket has been authenticated
    // An authenticated WebSocket will be in the clients Map
    if (this.clients.has(ws)) {
      return; // Authenticated, nothing to do
    }

    // After hibernation, the clients Map may be empty
    // Try to recover client info from the database
    // If recovery succeeds, the client was authenticated before hibernation
    const tags = this.ctx.getTags(ws);
    const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
    if (wsIdTag) {
      const tagWsId = wsIdTag.replace("wsid:", "");
      const mappingResult = this.sql.exec(
        `SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`,
        tagWsId
      );
      const mappings = mappingResult.toArray() as { participant_id: string }[];
      if (mappings.length > 0) {
        return; // Was authenticated before hibernation
      }
    }

    // Connection is unauthenticated after timeout - close it
    console.log(
      `[DO] Closing unauthenticated WebSocket after ${WS_AUTH_TIMEOUT_MS}ms timeout: ${wsId}`
    );
    try {
      ws.close(4008, "Authentication timeout");
    } catch {
      // WebSocket may have been closed by the client
    }
  }

  /**
   * Durable Object alarm handler.
   *
   * Called when a scheduled alarm fires. Used for:
   * 1. Inactivity monitoring - snapshot and stop after 10 minutes of no activity
   * 2. Heartbeat monitoring - detect stale sandboxes
   *
   * The 10-minute timeout balances cost efficiency with user experience:
   * - Short enough to avoid wasting resources on abandoned sessions
   * - Long enough for users to read/think between prompts
   * - Snapshots preserve all state, so resume is instant
   */
  async alarm(): Promise<void> {
    console.log("[DO] ===== ALARM FIRED =====");
    this.ensureInitialized();

    const sandbox = this.getSandbox();
    if (!sandbox) {
      console.log("[DO] Alarm: no sandbox found");
      return;
    }

    console.log(
      `[DO] Alarm: sandbox status=${sandbox.status}, last_activity=${sandbox.last_activity}, last_heartbeat=${sandbox.last_heartbeat}`
    );

    // Skip if sandbox is already stopped or failed
    if (sandbox.status === "stopped" || sandbox.status === "failed" || sandbox.status === "stale") {
      console.log(`[DO] Alarm: sandbox status is ${sandbox.status}, skipping`);
      return;
    }

    const now = Date.now();
    // Default 10 minutes, can be overridden with SANDBOX_INACTIVITY_TIMEOUT_MS env var for testing
    const INACTIVITY_TIMEOUT_MS = parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10);
    const HEARTBEAT_TIMEOUT_MS = 90000; // 3x heartbeat interval (30s)
    console.log(`[DO] Alarm: now=${now}, INACTIVITY_TIMEOUT_MS=${INACTIVITY_TIMEOUT_MS}`);

    // Check heartbeat health first - if stale, stop immediately
    if (this.handleHeartbeatTimeout(sandbox.last_heartbeat, now, HEARTBEAT_TIMEOUT_MS)) {
      return;
    }

    // Check for inactivity - snapshot and stop if no activity for configured time
    if (sandbox.last_activity && (sandbox.status === "ready" || sandbox.status === "running")) {
      const inactiveTime = now - sandbox.last_activity;
      console.log(
        `[DO] Alarm: inactiveTime=${inactiveTime}ms (${inactiveTime / 1000}s), timeout=${INACTIVITY_TIMEOUT_MS}ms`
      );

      if (inactiveTime >= INACTIVITY_TIMEOUT_MS) {
        // Check if any clients are still connected - they may be actively reviewing
        const connectedClients = this.ctx.getWebSockets().filter((ws) => {
          const tags = this.ctx.getTags(ws);
          return !tags.includes("sandbox") && ws.readyState === WebSocket.OPEN;
        });

        if (connectedClients.length > 0) {
          console.log(
            `[DO] Inactivity timeout but ${connectedClients.length} clients connected, extending 5 min`
          );
          this.broadcast({
            type: "sandbox_warning",
            message:
              "Sandbox will stop in 5 minutes due to inactivity. Send a message to keep it alive.",
          });
          await this.ctx.storage.setAlarm(now + 5 * 60 * 1000);
          return;
        }

        console.log(
          `[DO] Inactivity timeout: ${inactiveTime / 1000}s, triggering snapshot and stop`
        );

        // IMPORTANT: Set status to "stopped" FIRST to block any reconnection attempts
        // This prevents race conditions where sandbox reconnects before we finish cleanup
        this.updateSandboxStatus("stopped");
        this.broadcast({ type: "sandbox_status", status: "stopped" });
        console.log("[DO] Status set to stopped, blocking reconnections");

        // Now take the snapshot (modal_object_id is still in DB)
        await this.triggerSnapshot("inactivity_timeout");

        // Send shutdown command to sandbox and close WebSocket
        const sandboxWs = this.getSandboxWebSocket();
        if (sandboxWs) {
          this.safeSend(sandboxWs, { type: "shutdown" });
          try {
            sandboxWs.close(1000, "Inactivity timeout");
          } catch {
            // Ignore errors closing WebSocket
          }
          this.sandboxWs = null;
        }

        this.broadcast({
          type: "sandbox_warning",
          message: "Sandbox stopped due to inactivity, snapshot saved",
        });
        return;
      }

      // Not yet timed out - schedule next check at remaining time (min 30s)
      const remainingTime = Math.max(INACTIVITY_TIMEOUT_MS - inactiveTime, 30000);
      console.log(`[DO] Scheduling next alarm in ${remainingTime / 1000}s`);
      await this.ctx.storage.setAlarm(now + remainingTime);
    } else {
      // No last_activity yet - schedule check in 30s
      await this.ctx.storage.setAlarm(now + 30000);
    }
  }

  /**
   * Handle heartbeat timeout detection and response.
   * If stale, triggers snapshot, updates status to stale, and broadcasts to clients.
   *
   * @returns true if heartbeat timed out (caller should return early), false otherwise
   */
  private handleHeartbeatTimeout(
    lastHeartbeat: number | null,
    now: number,
    timeoutMs: number
  ): boolean {
    if (!lastHeartbeat) {
      return false;
    }

    const heartbeatAge = now - lastHeartbeat;
    if (heartbeatAge > timeoutMs) {
      console.log(`[DO] Heartbeat timeout: ${heartbeatAge / 1000}s since last heartbeat`);
      // Use fire-and-forget so status broadcast isn't delayed by snapshot
      this.ctx.waitUntil(this.triggerSnapshot("heartbeat_timeout"));
      this.updateSandboxStatus("stale");
      this.broadcast({ type: "sandbox_status", status: "stale" });
      return true;
    }

    return false;
  }

  // Note: Heartbeat health is now checked in the main alarm() handler
  // to avoid alarm conflicts (Durable Objects can only have one alarm at a time)

  /**
   * Update the last activity timestamp.
   */
  private updateLastActivity(timestamp: number): void {
    this.sql.exec(
      `UPDATE sandbox SET last_activity = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      timestamp
    );
  }

  /**
   * Schedule the inactivity check alarm.
   * Called when sandbox becomes ready or when activity occurs.
   */
  private async scheduleInactivityCheck(): Promise<void> {
    const INACTIVITY_CHECK_MS = parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10);
    const alarmTime = Date.now() + INACTIVITY_CHECK_MS;
    console.log(
      `[DO] Scheduling inactivity check in ${INACTIVITY_CHECK_MS / 1000}s (at ${new Date(alarmTime).toISOString()})`
    );
    await this.ctx.storage.setAlarm(alarmTime);
    console.log(`[DO] Alarm scheduled successfully`);
  }

  /**
   * Trigger a filesystem snapshot of the sandbox.
   *
   * Called when:
   * - Agent execution completes (per Ramp spec)
   * - Pre-timeout warning (approaching 2-hour Modal limit)
   * - Heartbeat timeout (sandbox may be unresponsive)
   *
   * Note: Only Modal backend supports snapshots. Cloudflare backend will skip.
   */
  private async triggerSnapshot(reason: string): Promise<void> {
    // Check if backend supports snapshots
    const sandboxManager = createSandboxManager(this.env);
    if (!sandboxManager.supportsSnapshots()) {
      console.log(
        `[DO] Snapshot skipped: ${getSandboxBackend(this.env)} backend does not support snapshots`
      );
      return;
    }

    const sandbox = this.getSandbox();
    const session = this.getSession();
    if (!sandbox?.modal_object_id || !session) {
      console.log("[DO] Cannot snapshot: no modal_object_id or session");
      return;
    }

    // Don't snapshot if already snapshotting
    if (sandbox.status === "snapshotting") {
      console.log("[DO] Already snapshotting, skipping");
      return;
    }

    // Track previous status only if we're not in a terminal state
    // Terminal states (stopped, stale, failed) should not be changed by snapshotting
    const isTerminalState =
      sandbox.status === "stopped" || sandbox.status === "stale" || sandbox.status === "failed";
    const previousStatus = sandbox.status;

    if (!isTerminalState) {
      this.updateSandboxStatus("snapshotting");
      this.broadcast({ type: "sandbox_status", status: "snapshotting" });
    }

    try {
      // Use sandbox manager for snapshot (only Modal supports this)
      if (sandboxManager.createSnapshot) {
        const result = await sandboxManager.createSnapshot({
          sandboxId: sandbox.modal_sandbox_id || "",
          modalObjectId: sandbox.modal_object_id,
          sessionId: session.session_name || session.id,
          reason,
        });

        if (result?.imageId) {
          // Store snapshot image ID for later restoration
          this.sql.exec(
            `UPDATE sandbox SET snapshot_image_id = ? WHERE id = ?`,
            result.imageId,
            sandbox.id
          );
          console.log(`[DO] Snapshot saved: ${result.imageId}`);
          this.broadcast({
            type: "snapshot_saved",
            imageId: result.imageId,
            reason,
          });
        } else {
          console.error("[DO] Snapshot failed: no imageId returned");
        }
      }
    } catch (error) {
      console.error("[DO] Snapshot request failed:", error);
    }

    // Restore previous status if we weren't in a terminal state
    // Terminal states (stopped, stale, failed) should persist after snapshot
    if (!isTerminalState && reason !== "heartbeat_timeout") {
      this.updateSandboxStatus(previousStatus);
      this.broadcast({ type: "sandbox_status", status: previousStatus });
    }
  }

  /**
   * Restore a sandbox from a filesystem snapshot.
   *
   * Called when resuming a session that has a saved snapshot.
   * Creates a new sandbox from the snapshot Image, skipping git clone.
   *
   * Note: Only Modal backend supports snapshot restore. For other backends,
   * this falls back to spawning a fresh sandbox.
   */
  private async restoreFromSnapshot(snapshotImageId: string): Promise<void> {
    const sandboxManager = createSandboxManager(this.env);

    // If backend doesn't support snapshots, fall back to fresh spawn
    if (!sandboxManager.supportsSnapshots() || !sandboxManager.restoreSnapshot) {
      console.log(
        `[DO] Snapshot restore not supported by ${getSandboxBackend(this.env)} backend, spawning fresh`
      );
      // Clear snapshot ID so spawnSandbox doesn't try to restore again
      this.sql.exec(
        `UPDATE sandbox SET snapshot_image_id = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
      );
      await this.spawnSandbox();
      return;
    }

    const session = this.getSession();
    if (!session) {
      console.error("[DO] Cannot restore: no session");
      return;
    }

    this.updateSandboxStatus("spawning");
    this.broadcast({ type: "sandbox_status", status: "spawning" });

    try {
      const now = Date.now();
      const sandboxAuthToken = generateId();
      const expectedSandboxId = `sandbox-${session.repo_owner}-${session.repo_name}-${now}`;

      // Store expected sandbox ID and auth token before restoring
      this.sql.exec(
        `UPDATE sandbox SET
           status = 'spawning',
           created_at = ?,
           auth_token = ?,
           modal_sandbox_id = ?
         WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        now,
        sandboxAuthToken,
        expectedSandboxId
      );

      // Get control plane URL
      const controlPlaneUrl =
        this.env.WORKER_URL ||
        `https://open-inspect-control-plane.${this.env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

      const { provider, model } = extractProviderAndModel(session.model || DEFAULT_MODEL);

      console.log(`[DO] Restoring sandbox from snapshot ${snapshotImageId}`);

      const result = await sandboxManager.restoreSnapshot({
        snapshotImageId,
        sessionId: session.session_name || session.id,
        sandboxId: expectedSandboxId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        controlPlaneUrl,
        sandboxAuthToken,
        provider,
        model,
      });

      if (result) {
        console.log(`[DO] Sandbox restored: ${result.sandboxId}`);

        // Store Modal's internal object ID if provided
        if (result.modalObjectId) {
          this.sql.exec(
            `UPDATE sandbox SET modal_object_id = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
            result.modalObjectId
          );
        }

        this.updateSandboxStatus("connecting");
        this.broadcast({ type: "sandbox_status", status: "connecting" });
        this.broadcast({
          type: "sandbox_restored",
          message: "Session restored from snapshot",
        });
      } else {
        console.error("[DO] Restore from snapshot failed");
        this.updateSandboxStatus("failed");
        this.broadcast({
          type: "sandbox_error",
          error: "Failed to restore from snapshot",
        });
      }
    } catch (error) {
      console.error("[DO] Restore from snapshot request failed:", error);
      this.updateSandboxStatus("failed");
      this.broadcast({
        type: "sandbox_error",
        error: error instanceof Error ? error.message : "Failed to restore sandbox",
      });
    }
  }

  /**
   * Handle messages from sandbox.
   */
  private async handleSandboxMessage(ws: WebSocket, message: string): Promise<void> {
    // Recover sandbox WebSocket reference after hibernation
    if (!this.sandboxWs || this.sandboxWs !== ws) {
      this.sandboxWs = ws;
    }

    try {
      const event = JSON.parse(message) as SandboxEvent;
      await this.processSandboxEvent(event);
    } catch (e) {
      console.error("Error processing sandbox message:", e);
    }
  }

  /**
   * Handle messages from clients.
   */
  private async handleClientMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const data = JSON.parse(message) as ClientMessage;

      switch (data.type) {
        case "ping":
          this.safeSend(ws, { type: "pong", timestamp: Date.now() });
          break;

        case "subscribe":
          await this.handleSubscribe(ws, data);
          break;

        case "prompt":
          await this.handlePromptMessage(ws, data);
          break;

        case "stop":
          await this.stopExecution();
          break;

        case "typing":
          await this.handleTyping();
          break;

        case "presence":
          await this.updatePresence(ws, data);
          break;
      }
    } catch (e) {
      console.error("Error processing client message:", e);
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Failed to process message",
      });
    }
  }

  /**
   * Handle client subscription with token validation.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: { token: string; clientId: string }
  ): Promise<void> {
    // Validate the WebSocket auth token
    if (!data.token) {
      console.log("[DO] WebSocket subscribe rejected: no token provided");
      ws.close(4001, "Authentication required");
      return;
    }

    // Hash the incoming token and look up participant
    const tokenHash = await hashToken(data.token);
    const participant = this.getParticipantByWsTokenHash(tokenHash);

    if (!participant) {
      console.log("[DO] WebSocket subscribe rejected: invalid token");
      ws.close(4001, "Invalid authentication token");
      return;
    }

    console.log(
      `[DO] WebSocket authenticated: participant=${participant.id}, user=${participant.user_id}`
    );

    // Build client info from participant data
    const clientInfo: ClientInfo = {
      participantId: participant.id,
      userId: participant.user_id,
      name: participant.github_name || participant.github_login || participant.user_id,
      avatar: getGitHubAvatarUrl(participant.github_login),
      status: "active",
      lastSeen: Date.now(),
      clientId: data.clientId,
      ws,
    };

    this.clients.set(ws, clientInfo);

    // Store WebSocket to participant mapping for hibernation recovery
    // Get the ws_id from the WebSocket's tags
    const wsTags = this.ctx.getTags(ws);
    const wsIdTag = wsTags.find((t) => t.startsWith("wsid:"));
    if (wsIdTag) {
      const wsId = wsIdTag.replace("wsid:", "");
      const now = Date.now();
      // Upsert the mapping (in case of reconnection)
      this.sql.exec(
        `INSERT OR REPLACE INTO ws_client_mapping (ws_id, participant_id, client_id, created_at)
         VALUES (?, ?, ?, ?)`,
        wsId,
        participant.id,
        data.clientId,
        now
      );
      console.log(`[DO] Stored ws_client_mapping: wsId=${wsId}, participant=${participant.id}`);
    }

    // Set auto-response for ping/pong during hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong", timestamp: Date.now() })
      )
    );

    // Send session state with current participant info
    const state = this.getSessionState();
    this.safeSend(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: participant.github_name || participant.github_login || participant.user_id,
        avatar: getGitHubAvatarUrl(participant.github_login),
      },
    } as ServerMessage);

    // Send historical events (messages and sandbox events)
    this.sendHistoricalEvents(ws);

    // Send current presence
    this.sendPresence(ws);

    // Notify others
    this.broadcastPresence();
  }

  /**
   * Send historical events to a newly connected client.
   */
  private sendHistoricalEvents(ws: WebSocket): void {
    // Get messages with participant info (user prompts)
    const messagesResult = this.sql.exec(
      `SELECT m.*, p.id as participant_id, p.github_name, p.github_login
       FROM messages m
       LEFT JOIN participants p ON m.author_id = p.id
       ORDER BY m.created_at ASC LIMIT 100`
    );
    const messages = messagesResult.toArray() as unknown as MessageWithParticipant[];

    // Get events (tool calls, tokens, etc.)
    const eventsResult = this.sql.exec(`SELECT * FROM events ORDER BY created_at ASC LIMIT 500`);
    const events = eventsResult.toArray() as unknown as EventRow[];

    // Combine and sort by timestamp
    interface HistoryItem {
      type: "message" | "event";
      timestamp: number;
      data: MessageWithParticipant | EventRow;
    }

    const combined: HistoryItem[] = [
      ...messages.map((m) => ({ type: "message" as const, timestamp: m.created_at, data: m })),
      ...events.map((e) => ({ type: "event" as const, timestamp: e.created_at, data: e })),
    ];

    // Sort by timestamp ascending
    combined.sort((a, b) => a.timestamp - b.timestamp);

    // Send in chronological order
    for (const item of combined) {
      if (item.type === "message") {
        const msg = item.data as MessageWithParticipant;
        this.safeSend(ws, {
          type: "sandbox_event",
          event: {
            type: "user_message",
            content: msg.content,
            messageId: msg.id,
            timestamp: msg.created_at / 1000, // Convert to seconds
            author: msg.participant_id
              ? {
                  participantId: msg.participant_id,
                  name: msg.github_name || msg.github_login || "Unknown",
                  avatar: getGitHubAvatarUrl(msg.github_login),
                }
              : undefined,
          },
        });
      } else {
        const event = item.data as EventRow;
        try {
          const eventData = JSON.parse(event.data);
          this.safeSend(ws, {
            type: "sandbox_event",
            event: eventData,
          });
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    // First check in-memory cache
    let client = this.clients.get(ws);
    if (client) return client;

    // After hibernation, the Map is empty but WebSocket is still valid
    // Try to recover client info from the database using ws_id tag
    const tags = this.ctx.getTags(ws);
    if (!tags.includes("sandbox")) {
      // This is a client WebSocket that survived hibernation
      // Try to recover from ws_client_mapping table
      const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
      if (wsIdTag) {
        const wsId = wsIdTag.replace("wsid:", "");
        const mappingResult = this.sql.exec(
          `SELECT m.participant_id, m.client_id, p.user_id, p.github_name, p.github_login
           FROM ws_client_mapping m
           JOIN participants p ON m.participant_id = p.id
           WHERE m.ws_id = ?`,
          wsId
        );
        const mappings = mappingResult.toArray() as {
          participant_id: string;
          client_id: string;
          user_id: string;
          github_name: string | null;
          github_login: string | null;
        }[];

        if (mappings.length > 0) {
          const mapping = mappings[0];
          console.log(`[DO] Recovered client info from DB: wsId=${wsId}, user=${mapping.user_id}`);
          client = {
            participantId: mapping.participant_id,
            userId: mapping.user_id,
            name: mapping.github_name || mapping.github_login || mapping.user_id,
            avatar: getGitHubAvatarUrl(mapping.github_login),
            status: "active",
            lastSeen: Date.now(),
            clientId: mapping.client_id || `client-${Date.now()}`,
            ws,
          };
          this.clients.set(ws, client);
          return client;
        }
      }

      // No mapping found - client must reconnect with valid auth
      console.log("[DO] No client mapping found after hibernation, closing WebSocket");
      ws.close(4002, "Session expired, please reconnect");
      return null;
    }

    return null;
  }

  /**
   * Handle prompt message from client.
   */
  private async handlePromptMessage(
    ws: WebSocket,
    data: {
      content: string;
      model?: string;
      attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
    }
  ): Promise<void> {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    const messageId = generateId();
    const now = Date.now();

    // Get or create participant
    let participant = this.getParticipantByUserId(client.userId);
    if (!participant) {
      participant = this.createParticipant(client.userId, client.name);
    }

    // Validate per-message model override if provided
    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        console.log(`[DO] Invalid message model "${data.model}", ignoring override`);
      }
    }

    // Insert message with optional model override
    this.sql.exec(
      `INSERT INTO messages (id, author_id, content, source, model, attachments, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      participant.id,
      data.content,
      "web",
      messageModel,
      data.attachments ? JSON.stringify(data.attachments) : null,
      "pending",
      now
    );

    // Get queue position
    const queueResult = this.sql.exec(
      `SELECT COUNT(*) as count FROM messages WHERE status IN ('pending', 'processing')`
    );
    const position = (queueResult.one() as { count: number }).count;

    // Confirm to sender
    this.safeSend(ws, {
      type: "prompt_queued",
      messageId,
      position,
    } as ServerMessage);

    // Process queue
    await this.processMessageQueue();
  }

  /**
   * Handle typing indicator (warm sandbox).
   */
  private async handleTyping(): Promise<void> {
    // If no sandbox or not connected, try to warm/spawn one
    if (!this.sandboxWs || this.sandboxWs.readyState !== WebSocket.OPEN) {
      if (!this.isSpawningSandbox) {
        this.broadcast({ type: "sandbox_warming" });
        // Proactively spawn sandbox when user starts typing
        await this.spawnSandbox();
      }
    }
  }

  /**
   * Update client presence.
   */
  private async updatePresence(
    ws: WebSocket,
    data: { status: "active" | "idle"; cursor?: { line: number; file: string } }
  ): Promise<void> {
    const client = this.getClientInfo(ws);
    if (client) {
      client.status = data.status;
      client.lastSeen = Date.now();
      this.broadcastPresence();
    }
  }

  /**
   * Process sandbox event.
   */
  private async processSandboxEvent(event: SandboxEvent): Promise<void> {
    console.log(`[DO] processSandboxEvent: type=${event.type}`);
    const now = Date.now();
    const eventId = generateId();

    // Get messageId from the event first (sandbox sends correct messageId with every event)
    // Only fall back to DB lookup if event doesn't include messageId (legacy fallback)
    // This prevents race conditions where events from message A arrive after message B starts processing
    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingResult = this.sql
      .exec(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`)
      .toArray() as Array<{ id: string }>;
    const messageId = eventMessageId ?? processingResult[0]?.id ?? null;

    // Store event
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      eventId,
      event.type,
      JSON.stringify(event),
      messageId,
      now
    );

    // Handle specific event types
    if (event.type === "execution_complete") {
      // Use the resolved messageId (which now correctly prioritizes event.messageId)
      const completionMessageId = messageId ?? event.messageId;
      const status = event.success ? "completed" : "failed";

      if (completionMessageId) {
        this.sql.exec(
          `UPDATE messages SET status = ?, completed_at = ? WHERE id = ?`,
          status,
          now,
          completionMessageId
        );

        // Broadcast processing status change (after DB update so getIsProcessing is accurate)
        this.broadcast({ type: "processing_status", isProcessing: this.getIsProcessing() });

        // Notify slack-bot of completion (fire-and-forget with retry)
        this.ctx.waitUntil(this.notifySlackBot(completionMessageId, event.success));
      } else {
        console.error("[DO] execution_complete: no messageId available for status update");
      }

      // Take snapshot after execution completes (per Ramp spec)
      // "When the agent is finished making changes, we take another snapshot"
      // Use fire-and-forget so snapshot doesn't block the response to the user
      this.ctx.waitUntil(this.triggerSnapshot("execution_complete"));

      // Reset activity timer - give user time to review output before inactivity timeout
      this.updateLastActivity(now);
      await this.scheduleInactivityCheck();

      // Process next in queue
      await this.processMessageQueue();
    }

    if (event.type === "git_sync") {
      this.sql.exec(
        `UPDATE sandbox SET git_sync_status = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        event.status
      );

      if (event.sha) {
        this.sql.exec(`UPDATE session SET current_sha = ?`, event.sha);
      }
    }

    if (event.type === "heartbeat") {
      this.sql.exec(
        `UPDATE sandbox SET last_heartbeat = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        now
      );
      // Note: Don't schedule separate heartbeat alarm - it's handled in the main alarm()
      // which checks both inactivity and heartbeat health
    }

    // Handle push completion events
    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    // Broadcast to clients
    this.broadcast({ type: "sandbox_event", event });
  }

  /**
   * Push a branch to remote via the sandbox.
   * Sends push command to sandbox and waits for completion or error.
   *
   * @returns Success result or error message
   */
  private async pushBranchToRemote(
    branchName: string,
    repoOwner: string,
    repoName: string,
    githubToken?: string
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.getSandboxWebSocket();

    if (!sandboxWs) {
      // No sandbox connected - user may have already pushed manually
      console.log("[DO] No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    // Create a promise that will be resolved when push_complete event arrives
    // Use normalized branch name for map key to handle case/whitespace differences
    const normalizedBranch = this.normalizeBranchName(branchName);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(normalizedBranch, { resolve, reject });

      // Timeout after 180 seconds (3 minutes) - git push can take a while
      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(normalizedBranch)) {
          this.pendingPushResolvers.delete(normalizedBranch);
          reject(new Error("Push operation timed out after 180 seconds"));
        }
      }, 180000);
    });

    // Tell sandbox to push the current branch
    // Pass GitHub App token for authentication (sandbox uses for git push)
    // User's OAuth token is NOT sent to sandbox - only used server-side for PR API
    console.log(`[DO] Sending push command for branch ${branchName}`);
    this.safeSend(sandboxWs, {
      type: "push",
      branchName,
      repoOwner,
      repoName,
      githubToken,
    });

    // Wait for push_complete or push_error event
    try {
      await pushPromise;
      console.log(`[DO] Push completed successfully for branch ${branchName}`);
      return { success: true };
    } catch (pushError) {
      console.error(`[DO] Push failed: ${pushError}`);
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      // Clean up timeout to prevent memory leaks
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Handle push completion or error events from sandbox.
   * Resolves or rejects the pending push promise for the branch.
   */
  private handlePushEvent(event: SandboxEvent): void {
    const branchName = (event as { branchName?: string }).branchName;

    if (!branchName) {
      return;
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    const resolver = this.pendingPushResolvers.get(normalizedBranch);

    if (!resolver) {
      return;
    }

    if (event.type === "push_complete") {
      console.log(
        `[DO] push_complete event: branchName=${branchName}, pendingResolvers=${Array.from(this.pendingPushResolvers.keys()).join(",")}`
      );
      console.log(`[DO] Push completed for branch ${branchName}, resolving promise`);
      resolver.resolve();
    } else if (event.type === "push_error") {
      const error = (event as { error?: string }).error || "Push failed";
      console.log(`[DO] Push failed for branch ${branchName}: ${error}`);
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(normalizedBranch);
  }

  /**
   * Get the sandbox WebSocket, recovering from hibernation if needed.
   */
  private getSandboxWebSocket(): WebSocket | null {
    // First check in-memory reference
    if (this.sandboxWs && this.sandboxWs.readyState === WebSocket.OPEN) {
      return this.sandboxWs;
    }

    // After hibernation, try to recover from ctx.getWebSockets()
    // Validate sandbox ID to prevent wrong sandbox connections
    const sandbox = this.getSandbox();
    const expectedSandboxId = sandbox?.modal_sandbox_id;

    const allWebSockets = this.ctx.getWebSockets();
    for (const ws of allWebSockets) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes("sandbox") && ws.readyState === WebSocket.OPEN) {
        // Validate sandbox ID if we have an expected one
        if (expectedSandboxId) {
          const sidTag = tags.find((t) => t.startsWith("sid:"));
          if (sidTag) {
            const tagSandboxId = sidTag.replace("sid:", "");
            if (tagSandboxId !== expectedSandboxId) {
              console.log(
                `[DO] Skipping WS with wrong sandbox ID: ${tagSandboxId} (expected ${expectedSandboxId})`
              );
              continue;
            }
          }
        }
        console.log("[DO] Recovered sandbox WebSocket from hibernation");
        this.sandboxWs = ws;
        return ws;
      }
    }

    return null;
  }

  /**
   * Process message queue.
   */
  private async processMessageQueue(): Promise<void> {
    console.log("processMessageQueue: start");

    // Check if already processing
    const processing = this.sql.exec(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`);
    if (processing.toArray().length > 0) {
      console.log("processMessageQueue: already processing, returning");
      return;
    }

    // Get next pending message
    const pending = this.sql.exec(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    );
    const messages = pending.toArray() as unknown as MessageRow[];
    if (messages.length === 0) {
      console.log("processMessageQueue: no pending messages");
      return;
    }

    const message = messages[0];
    console.log("processMessageQueue: found message", message.id);
    const now = Date.now();

    // Check if sandbox is connected (with hibernation recovery)
    const sandboxWs = this.getSandboxWebSocket();
    console.log("processMessageQueue: checking sandbox", {
      hasSandboxWs: !!sandboxWs,
      readyState: sandboxWs?.readyState,
      OPEN: WebSocket.OPEN,
    });
    if (!sandboxWs) {
      // No sandbox connected - spawn one if not already spawning
      // spawnSandbox has its own persisted status check
      console.log("processMessageQueue: no sandbox, attempting spawn");
      this.broadcast({ type: "sandbox_spawning" });
      await this.spawnSandbox();
      // Don't mark as processing yet - wait for sandbox to connect
      return;
    }

    console.log("processMessageQueue: marking as processing");
    // Mark as processing
    this.sql.exec(
      `UPDATE messages SET status = 'processing', started_at = ? WHERE id = ?`,
      now,
      message.id
    );

    // Broadcast processing status change (hardcoded true since we just set status above)
    this.broadcast({ type: "processing_status", isProcessing: true });

    // Reset activity timer - user is actively using the sandbox
    this.updateLastActivity(now);

    // Get author info (use toArray since author may not exist in participants table)
    console.log("processMessageQueue: getting author", message.author_id);
    const authorResult = this.sql.exec(
      `SELECT * FROM participants WHERE id = ?`,
      message.author_id
    );
    const authorRows = authorResult.toArray() as unknown as ParticipantRow[];
    const author = authorRows[0] ?? null;
    console.log("processMessageQueue: author found", !!author);

    // Get session for default model
    const session = this.getSession();

    // Send to sandbox with model (per-message override or session default)
    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: message.model || session?.model || "claude-haiku-4-5",
      author: {
        userId: author?.user_id ?? "unknown",
        githubName: author?.github_name ?? null,
        githubEmail: author?.github_email ?? null,
      },
      attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
    };

    console.log("processMessageQueue: sending to sandbox");
    this.safeSend(sandboxWs, command);
    console.log("processMessageQueue: sent");
  }

  /**
   * Enforce circuit breaker for sandbox spawning.
   * Blocks spawning after 3 failures within 5 minutes and broadcasts error to clients.
   * Resets failure count if the circuit breaker window has passed.
   *
   * @returns true if spawning should proceed, false if blocked by circuit breaker
   */
  private enforceCircuitBreaker(spawnFailureCount: number, lastSpawnFailure: number): boolean {
    const CIRCUIT_BREAKER_THRESHOLD = 3;
    const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    const timeSinceLastFailure = now - lastSpawnFailure;

    if (
      spawnFailureCount >= CIRCUIT_BREAKER_THRESHOLD &&
      timeSinceLastFailure < CIRCUIT_BREAKER_WINDOW_MS
    ) {
      console.log(
        `[DO] Circuit breaker open: ${spawnFailureCount} failures in last ${timeSinceLastFailure / 1000}s`
      );
      this.broadcast({
        type: "sandbox_error",
        error: `Sandbox spawning temporarily disabled after ${spawnFailureCount} failures. Try again in ${Math.ceil((CIRCUIT_BREAKER_WINDOW_MS - timeSinceLastFailure) / 1000)} seconds.`,
      });
      return false;
    }

    // Reset circuit breaker if window has passed
    if (spawnFailureCount > 0 && timeSinceLastFailure >= CIRCUIT_BREAKER_WINDOW_MS) {
      console.log("[DO] Circuit breaker window passed, resetting failure count");
      this.sql.exec(
        `UPDATE sandbox SET spawn_failure_count = 0 WHERE id = (SELECT id FROM sandbox LIMIT 1)`
      );
    }

    return true;
  }

  /**
   * Spawn a sandbox using the configured backend (Modal or Cloudflare).
   */
  private async spawnSandbox(): Promise<void> {
    // Check persisted status and last spawn time to prevent duplicate spawns
    const sandboxResult = this.sql.exec(
      `SELECT status, created_at, snapshot_image_id, spawn_failure_count, last_spawn_failure FROM sandbox LIMIT 1`
    );
    const sandboxRows = sandboxResult.toArray() as {
      status: string;
      created_at: number;
      snapshot_image_id: string | null;
      spawn_failure_count: number | null;
      last_spawn_failure: number | null;
    }[];
    const currentStatus = sandboxRows[0]?.status;
    const lastSpawnTime = sandboxRows[0]?.created_at || 0;
    const snapshotImageId = sandboxRows[0]?.snapshot_image_id;
    const spawnFailureCount = sandboxRows[0]?.spawn_failure_count || 0;
    const lastSpawnFailure = sandboxRows[0]?.last_spawn_failure || 0;
    const now = Date.now();
    const timeSinceLastSpawn = now - lastSpawnTime;

    // Check circuit breaker
    if (!this.enforceCircuitBreaker(spawnFailureCount, lastSpawnFailure)) {
      return;
    }

    // Check if we have a snapshot to restore from (only for backends that support it)
    // This implements the Ramp spec: "restore to it later if the sandbox has exited and the user sends a follow up"
    const sandboxManager = createSandboxManager(this.env);
    if (
      snapshotImageId &&
      sandboxManager.supportsSnapshots() &&
      (currentStatus === "stopped" || currentStatus === "stale" || currentStatus === "failed")
    ) {
      console.log(`[DO] Found snapshot ${snapshotImageId}, restoring instead of fresh spawn`);
      await this.restoreFromSnapshot(snapshotImageId);
      return;
    }

    // Don't spawn if already spawning or connecting (persisted check)
    if (currentStatus === "spawning" || currentStatus === "connecting") {
      console.log(`[DO] spawnSandbox: already ${currentStatus}, skipping`);
      return;
    }

    // Don't spawn if status is "ready" and we have an active WebSocket
    if (currentStatus === "ready") {
      const existingSandboxWs = this.getSandboxWebSocket();
      if (existingSandboxWs) {
        console.log("[DO] spawnSandbox: sandbox ready with active WebSocket, skipping");
        return;
      }
      // If no WebSocket but was recently spawned, wait for reconnect
      if (timeSinceLastSpawn < 60000) {
        console.log(
          `[DO] spawnSandbox: status ready but no WebSocket, last spawn was ${timeSinceLastSpawn / 1000}s ago, waiting`
        );
        return;
      }
    }

    // Cooldown: don't spawn if last spawn was within 30 seconds
    if (timeSinceLastSpawn < 30000 && currentStatus !== "failed" && currentStatus !== "stopped") {
      console.log(`[DO] spawnSandbox: last spawn was ${timeSinceLastSpawn / 1000}s ago, waiting`);
      return;
    }

    // Also check in-memory flag for same-request protection
    if (this.isSpawningSandbox) {
      console.log("[DO] spawnSandbox: isSpawningSandbox=true, skipping");
      return;
    }
    this.isSpawningSandbox = true;

    try {
      const session = this.getSession();
      if (!session) {
        console.error("Cannot spawn sandbox: no session");
        return;
      }

      // Use the session_name for WebSocket routing (not the DO internal ID)
      const sessionId = session.session_name || this.ctx.id.toString();
      const sandboxAuthToken = generateId(); // Token for sandbox to authenticate

      // Generate predictable sandbox ID
      // This allows us to validate the connecting sandbox
      const expectedSandboxId = `sandbox-${session.repo_owner}-${session.repo_name}-${now}`;

      // Store status, auth token, AND expected sandbox ID BEFORE spawning
      // This prevents race conditions where sandbox connects before we've stored expected ID
      this.sql.exec(
        `UPDATE sandbox SET
           status = 'spawning',
           created_at = ?,
           auth_token = ?,
           modal_sandbox_id = ?
         WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        now,
        sandboxAuthToken,
        expectedSandboxId
      );
      this.broadcast({ type: "sandbox_status", status: "spawning" });

      const backend = getSandboxBackend(this.env);
      console.log(
        `[DO] Creating sandbox via ${backend}: ${session.session_name}, sandboxId=${expectedSandboxId}`
      );

      // Get the control plane URL from env or construct it
      const controlPlaneUrl =
        this.env.WORKER_URL ||
        `https://open-inspect-control-plane.${this.env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

      const { provider, model } = extractProviderAndModel(session.model || DEFAULT_MODEL);

      // Get GitHub App token for repo access (used by Cloudflare backend)
      let githubAppToken: string | undefined;
      if (backend === "cloudflare") {
        try {
          const appConfig = getGitHubAppConfig(this.env);
          if (appConfig) {
            githubAppToken = await generateInstallationToken(appConfig);
          }
        } catch (e) {
          console.log("[DO] GitHub App token not available:", e);
        }
      }

      // Use sandbox manager to start sandbox
      const result = await sandboxManager.startSandbox({
        sessionId,
        sandboxId: expectedSandboxId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        controlPlaneUrl,
        sandboxAuthToken,
        provider,
        model,
        githubAppToken, // Only used by Cloudflare backend
      });

      console.log(`${backend} sandbox created:`, result);

      // Store Modal's internal object ID for snapshot API calls (Modal-specific)
      if (result.modalObjectId) {
        this.sql.exec(
          `UPDATE sandbox SET modal_object_id = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
          result.modalObjectId
        );
        console.log(`[DO] Stored modal_object_id: ${result.modalObjectId}`);
      }

      this.updateSandboxStatus("connecting");
      this.broadcast({ type: "sandbox_status", status: "connecting" });

      // Reset circuit breaker on successful spawn initiation
      this.sql.exec(
        `UPDATE sandbox SET spawn_failure_count = 0 WHERE id = (SELECT id FROM sandbox LIMIT 1)`
      );
    } catch (error) {
      console.error("Failed to spawn sandbox:", error);

      // Increment circuit breaker failure count
      const failureNow = Date.now();
      this.sql.exec(
        `UPDATE sandbox SET
           spawn_failure_count = COALESCE(spawn_failure_count, 0) + 1,
           last_spawn_failure = ?
         WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        failureNow
      );
      console.log("[DO] Incremented spawn failure count for circuit breaker");

      this.updateSandboxStatus("failed");
      this.broadcast({
        type: "sandbox_error",
        error: error instanceof Error ? error.message : "Failed to spawn sandbox",
      });
    } finally {
      this.isSpawningSandbox = false;
    }
  }

  /**
   * Stop current execution.
   * Sends stop command to sandbox, which should respond with execution_complete.
   * The processing status will be updated when execution_complete is received.
   */
  private async stopExecution(): Promise<void> {
    if (this.sandboxWs) {
      this.safeSend(this.sandboxWs, { type: "stop" });
    }
  }

  /**
   * Broadcast message to all connected clients.
   */
  private broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (!tags.includes("sandbox")) {
        this.safeSend(ws, message);
      }
    }
  }

  /**
   * Send presence info to a specific client.
   */
  private sendPresence(ws: WebSocket): void {
    const participants = this.getPresenceList();
    this.safeSend(ws, { type: "presence_sync", participants });
  }

  /**
   * Broadcast presence to all clients.
   */
  private broadcastPresence(): void {
    const participants = this.getPresenceList();
    this.broadcast({ type: "presence_update", participants });
  }

  /**
   * Get list of present participants.
   */
  private getPresenceList(): ParticipantPresence[] {
    return Array.from(this.clients.values()).map((c) => ({
      participantId: c.participantId,
      userId: c.userId,
      name: c.name,
      avatar: c.avatar,
      status: c.status,
      lastSeen: c.lastSeen,
    }));
  }

  /**
   * Get current session state.
   */
  private getSessionState(): SessionState {
    const session = this.getSession();
    const sandbox = this.getSandbox();
    const messageCount = this.getMessageCount();
    const isProcessing = this.getIsProcessing();

    return {
      id: session?.id ?? this.ctx.id.toString(),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? "",
      repoName: session?.repo_name ?? "",
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      isProcessing,
    };
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    const result = this.sql.exec(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`);
    return result.toArray().length > 0;
  }

  // Database helpers

  private getSession(): SessionRow | null {
    const result = this.sql.exec(`SELECT * FROM session LIMIT 1`);
    const rows = result.toArray() as unknown as SessionRow[];
    return rows[0] ?? null;
  }

  private getSandbox(): SandboxRow | null {
    const result = this.sql.exec(`SELECT * FROM sandbox LIMIT 1`);
    const rows = result.toArray() as unknown as SandboxRow[];
    return rows[0] ?? null;
  }

  /**
   * Verify a sandbox authentication token.
   * Called by the router to validate sandbox-originated requests.
   */
  private async handleVerifySandboxToken(request: Request): Promise<Response> {
    const body = (await request.json()) as { token: string };

    if (!body.token) {
      return new Response(JSON.stringify({ valid: false, error: "Missing token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sandbox = this.getSandbox();
    if (!sandbox) {
      console.log("[DO] Sandbox token verification failed: no sandbox");
      return new Response(JSON.stringify({ valid: false, error: "No sandbox" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check if sandbox is in an active state
    if (sandbox.status === "stopped" || sandbox.status === "stale") {
      console.log(`[DO] Sandbox token verification failed: sandbox is ${sandbox.status}`);
      return new Response(JSON.stringify({ valid: false, error: "Sandbox stopped" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate the token
    if (body.token !== sandbox.auth_token) {
      console.log("[DO] Sandbox token verification failed: token mismatch");
      return new Response(JSON.stringify({ valid: false, error: "Invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("[DO] Sandbox token verified successfully");
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private getMessageCount(): number {
    const result = this.sql.exec(`SELECT COUNT(*) as count FROM messages`);
    return (result.one() as { count: number }).count;
  }

  private getParticipantByUserId(userId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE user_id = ?`, userId);
    const rows = result.toArray() as unknown as ParticipantRow[];
    return rows[0] ?? null;
  }

  private createParticipant(userId: string, name: string): ParticipantRow {
    const id = generateId();
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO participants (id, user_id, github_name, role, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      userId,
      name,
      "member",
      now
    );

    return {
      id,
      user_id: userId,
      github_user_id: null,
      github_login: null,
      github_email: null,
      github_name: name,
      role: "member",
      github_access_token_encrypted: null,
      github_refresh_token_encrypted: null,
      github_token_expires_at: null,
      ws_auth_token: null,
      ws_token_created_at: null,
      joined_at: now,
    };
  }

  private updateSandboxStatus(status: string): void {
    this.sql.exec(
      `UPDATE sandbox SET status = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      status
    );
  }

  /**
   * Generate HMAC signature for callback payload.
   */
  private async signCallback(data: object, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureData = encoder.encode(JSON.stringify(data));
    const sig = await crypto.subtle.sign("HMAC", key, signatureData);
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Notify slack-bot of completion with retry.
   * Uses service binding for reliable internal communication.
   */
  private async notifySlackBot(messageId: string, success: boolean): Promise<void> {
    // Safely query for callback context
    const result = this.sql
      .exec(`SELECT callback_context FROM messages WHERE id = ?`, messageId)
      .toArray() as Array<{ callback_context: string | null }>;

    const message = result[0];
    if (!message?.callback_context) {
      console.log(`[DO] No callback context for message ${messageId}, skipping notification`);
      return;
    }
    if (!this.env.SLACK_BOT || !this.env.INTERNAL_CALLBACK_SECRET) {
      console.log(
        "[DO] SLACK_BOT or INTERNAL_CALLBACK_SECRET not configured, skipping notification"
      );
      return;
    }

    const session = this.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const context = JSON.parse(message.callback_context);
    const timestamp = Date.now();

    // Build payload without signature
    const payloadData = {
      sessionId,
      messageId,
      success,
      timestamp,
      context,
    };

    // Sign the payload
    const signature = await this.signCallback(payloadData, this.env.INTERNAL_CALLBACK_SECRET);

    const payload = { ...payloadData, signature };

    // Try with retry (max 2 attempts)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.env.SLACK_BOT.fetch("https://internal/callbacks/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          console.log(`[DO] Slack callback succeeded for message ${messageId}`);
          return;
        }

        console.error(`[DO] Slack callback failed: ${response.status} ${await response.text()}`);
      } catch (e) {
        console.error(`[DO] Slack callback attempt ${attempt + 1} failed:`, e);
      }

      // Wait before retry
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.error(`[DO] Failed to notify slack-bot after retries for message ${messageId}`);
  }

  /**
   * Check if a participant's GitHub token is expired.
   * Returns true if expired or will expire within buffer time.
   */
  private isGitHubTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
    if (!participant.github_token_expires_at) {
      return false; // No expiration set, assume valid
    }
    return Date.now() + bufferMs >= participant.github_token_expires_at;
  }

  /**
   * Get the prompting user for PR creation.
   * Returns the participant who triggered the currently processing message.
   */
  private async getPromptingUserForPR(): Promise<
    | { user: ParticipantRow; error?: never; status?: never }
    | { user?: never; error: string; status: number }
  > {
    // Find the currently processing message
    const processingResult = this.sql.exec(
      `SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const processingRows = processingResult.toArray() as Array<{ author_id: string }>;

    if (processingRows.length === 0) {
      console.log("[DO] PR creation failed: no processing message found");
      return {
        error: "No active prompt found. PR creation must be triggered by a user prompt.",
        status: 400,
      };
    }

    const participantId = processingRows[0].author_id;

    // Get the participant record
    const participantResult = this.sql.exec(
      `SELECT * FROM participants WHERE id = ?`,
      participantId
    );
    const participants = participantResult.toArray() as unknown as ParticipantRow[];
    const participant = participants[0];

    if (!participant) {
      console.log(`[DO] PR creation failed: participant not found for id=${participantId}`);
      return { error: "User not found. Please re-authenticate.", status: 401 };
    }

    if (!participant.github_access_token_encrypted) {
      console.log(`[DO] PR creation failed: no GitHub token for user_id=${participant.user_id}`);
      return {
        error:
          "Your GitHub token is not available for PR creation. Please reconnect to the session to re-authenticate.",
        status: 401,
      };
    }

    if (this.isGitHubTokenExpired(participant)) {
      console.log(
        `[DO] PR creation failed: GitHub token expired for user_id=${participant.user_id}`
      );
      return { error: "Your GitHub token has expired. Please re-authenticate.", status: 401 };
    }

    return { user: participant };
  }

  // HTTP handlers

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionName: string; // The name used for WebSocket routing
      repoOwner: string;
      repoName: string;
      title?: string;
      model?: string; // LLM model to use
      userId: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      githubToken?: string | null; // Plain GitHub token (will be encrypted)
      githubTokenEncrypted?: string | null; // Pre-encrypted GitHub token
    };

    const sessionId = this.ctx.id.toString();
    const sessionName = body.sessionName; // Store the WebSocket routing name
    const now = Date.now();

    // Encrypt the GitHub token if provided in plain text
    let encryptedToken = body.githubTokenEncrypted ?? null;
    if (body.githubToken && this.env.TOKEN_ENCRYPTION_KEY) {
      try {
        const { encryptToken } = await import("../auth/crypto");
        encryptedToken = await encryptToken(body.githubToken, this.env.TOKEN_ENCRYPTION_KEY);
        console.log("[DO] Encrypted GitHub token for storage");
      } catch (err) {
        console.error("[DO] Failed to encrypt GitHub token:", err);
      }
    }

    // Validate model name if provided
    const model = body.model && isValidModel(body.model) ? body.model : DEFAULT_MODEL;
    if (body.model && !isValidModel(body.model)) {
      console.log(`[DO] Invalid model name "${body.model}", using default "${DEFAULT_MODEL}"`);
    }

    // Create session (store both internal ID and external name)
    this.sql.exec(
      `INSERT OR REPLACE INTO session (id, session_name, title, repo_owner, repo_name, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      sessionName, // Store the session name for WebSocket routing
      body.title ?? null,
      body.repoOwner,
      body.repoName,
      model,
      "created",
      now,
      now
    );

    // Create sandbox record
    // Note: created_at is set to 0 initially so the first spawn isn't blocked by cooldown
    // It will be updated to the actual spawn time when spawnSandbox() is called
    const sandboxId = generateId();
    this.sql.exec(
      `INSERT INTO sandbox (id, status, git_sync_status, created_at)
       VALUES (?, ?, ?, ?)`,
      sandboxId,
      "pending",
      "pending",
      0
    );

    // Create owner participant with encrypted GitHub token
    const participantId = generateId();
    this.sql.exec(
      `INSERT INTO participants (id, user_id, github_login, github_name, github_email, github_access_token_encrypted, role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      participantId,
      body.userId,
      body.githubLogin ?? null,
      body.githubName ?? null,
      body.githubEmail ?? null,
      encryptedToken,
      "owner",
      now
    );

    return Response.json({ sessionId, status: "created" });
  }

  private handleGetState(): Response {
    const session = this.getSession();
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    const sandbox = this.getSandbox();

    return Response.json({
      id: session.id,
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      repoDefaultBranch: session.repo_default_branch,
      branchName: session.branch_name,
      baseSha: session.base_sha,
      currentSha: session.current_sha,
      opencodeSessionId: session.opencode_session_id,
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      sandbox: sandbox
        ? {
            id: sandbox.id,
            modalSandboxId: sandbox.modal_sandbox_id,
            status: sandbox.status,
            gitSyncStatus: sandbox.git_sync_status,
            lastHeartbeat: sandbox.last_heartbeat,
          }
        : null,
    });
  }

  private async handleEnqueuePrompt(request: Request): Promise<Response> {
    try {
      console.log("handleEnqueuePrompt: start");
      const body = (await request.json()) as {
        content: string;
        authorId: string;
        source: string;
        attachments?: Array<{ type: string; name: string; url?: string }>;
        callbackContext?: {
          channel: string;
          threadTs: string;
          repoFullName: string;
          model: string;
        };
      };

      console.log("handleEnqueuePrompt: parsed body", {
        content: body.content?.substring(0, 50),
        authorId: body.authorId,
        source: body.source,
        hasCallbackContext: !!body.callbackContext,
      });

      // Get or create participant for the author
      // The authorId here is a user ID (like "anonymous"), not a participant row ID
      let participant = this.getParticipantByUserId(body.authorId);
      if (!participant) {
        console.log("handleEnqueuePrompt: creating participant for", body.authorId);
        participant = this.createParticipant(body.authorId, body.authorId);
      }

      const messageId = generateId();
      const now = Date.now();

      console.log(
        "handleEnqueuePrompt: inserting message",
        messageId,
        "with author",
        participant.id
      );
      this.sql.exec(
        `INSERT INTO messages (id, author_id, content, source, attachments, callback_context, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        messageId,
        participant.id, // Use the participant's row ID, not the user ID
        body.content,
        body.source,
        body.attachments ? JSON.stringify(body.attachments) : null,
        body.callbackContext ? JSON.stringify(body.callbackContext) : null,
        "pending",
        now
      );

      console.log("handleEnqueuePrompt: message inserted, processing queue");
      await this.processMessageQueue();

      console.log("handleEnqueuePrompt: done");
      return Response.json({ messageId, status: "queued" });
    } catch (error) {
      console.error("handleEnqueuePrompt error:", error);
      throw error;
    }
  }

  private handleStop(): Response {
    this.stopExecution();
    return Response.json({ status: "stopping" });
  }

  private async handleSandboxEvent(request: Request): Promise<Response> {
    const event = (await request.json()) as SandboxEvent;
    await this.processSandboxEvent(event);
    return Response.json({ status: "ok" });
  }

  private handleListParticipants(): Response {
    const result = this.sql.exec(`SELECT * FROM participants ORDER BY joined_at`);
    const participants = result.toArray() as unknown as ParticipantRow[];

    return Response.json({
      participants: participants.map((p) => ({
        id: p.id,
        userId: p.user_id,
        githubLogin: p.github_login,
        githubName: p.github_name,
        role: p.role,
        joinedAt: p.joined_at,
      })),
    });
  }

  private async handleAddParticipant(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      role?: string;
    };

    const id = generateId();
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO participants (id, user_id, github_login, github_name, github_email, role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.userId,
      body.githubLogin ?? null,
      body.githubName ?? null,
      body.githubEmail ?? null,
      body.role ?? "member",
      now
    );

    return Response.json({ id, status: "added" });
  }

  private handleListEvents(url: URL): Response {
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const type = url.searchParams.get("type");
    const messageId = url.searchParams.get("message_id");

    // Validate type parameter if provided
    if (type && !VALID_EVENT_TYPES.includes(type as (typeof VALID_EVENT_TYPES)[number])) {
      return Response.json({ error: `Invalid event type: ${type}` }, { status: 400 });
    }

    let query = `SELECT * FROM events WHERE 1=1`;
    const params: (string | number)[] = [];

    if (type) {
      query += ` AND type = ?`;
      params.push(type);
    }

    if (messageId) {
      query += ` AND message_id = ?`;
      params.push(messageId);
    }

    if (cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const result = this.sql.exec(query, ...params);
    const events = result.toArray() as unknown as EventRow[];
    const hasMore = events.length > limit;

    if (hasMore) events.pop();

    return Response.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        data: JSON.parse(e.data),
        messageId: e.message_id,
        createdAt: e.created_at,
      })),
      cursor: events.length > 0 ? events[events.length - 1].created_at.toString() : undefined,
      hasMore,
    });
  }

  private handleListArtifacts(): Response {
    const result = this.sql.exec(`SELECT * FROM artifacts ORDER BY created_at DESC`);
    const artifacts = result.toArray() as unknown as ArtifactRow[];

    return Response.json({
      artifacts: artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        url: a.url,
        metadata: a.metadata ? JSON.parse(a.metadata) : null,
        createdAt: a.created_at,
      })),
    });
  }

  private handleListMessages(url: URL): Response {
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const status = url.searchParams.get("status");

    // Validate status parameter if provided
    if (
      status &&
      !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])
    ) {
      return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
    }

    let query = `SELECT * FROM messages WHERE 1=1`;
    const params: (string | number)[] = [];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const result = this.sql.exec(query, ...params);
    const messages = result.toArray() as unknown as MessageRow[];
    const hasMore = messages.length > limit;

    if (hasMore) messages.pop();

    return Response.json({
      messages: messages.map((m) => ({
        id: m.id,
        authorId: m.author_id,
        content: m.content,
        source: m.source,
        status: m.status,
        createdAt: m.created_at,
        startedAt: m.started_at,
        completedAt: m.completed_at,
      })),
      cursor: messages.length > 0 ? messages[messages.length - 1].created_at.toString() : undefined,
      hasMore,
    });
  }

  /**
   * Handle PR creation request.
   * 1. Get prompting user's GitHub token (required, no fallback)
   * 2. Send push command to sandbox
   * 3. Create PR using GitHub API
   */
  private async handleCreatePR(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      title: string;
      body: string;
      baseBranch?: string;
    };

    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Get the prompting user who will create the PR
    const promptingUser = await this.getPromptingUserForPR();
    if (!promptingUser.user) {
      return Response.json({ error: promptingUser.error }, { status: promptingUser.status });
    }

    console.log(`[DO] Creating PR as user: ${promptingUser.user.user_id}`);

    const user = promptingUser.user;

    try {
      // Decrypt the prompting user's GitHub token
      const accessToken = await decryptToken(
        user.github_access_token_encrypted!,
        this.env.TOKEN_ENCRYPTION_KEY
      );

      // Get repository info to determine default branch
      const repoInfo = await getRepository(accessToken, session.repo_owner, session.repo_name);

      const baseBranch = body.baseBranch || repoInfo.defaultBranch;
      const sessionId = session.session_name || session.id;
      const headBranch = generateBranchName(sessionId);

      // Generate GitHub App token for push (not user token)
      // User token is only used for PR API call below
      let pushToken: string | undefined;
      const appConfig = getGitHubAppConfig(this.env);
      if (appConfig) {
        try {
          pushToken = await generateInstallationToken(appConfig);
          console.log("[DO] Generated fresh GitHub App token for push");
        } catch (err) {
          console.error("[DO] Failed to generate app token, push may fail:", err);
        }
      }

      // Push branch to remote via sandbox
      const pushResult = await this.pushBranchToRemote(
        headBranch,
        session.repo_owner,
        session.repo_name,
        pushToken
      );

      if (!pushResult.success) {
        return Response.json({ error: pushResult.error }, { status: 500 });
      }

      // Append session link footer to agent's PR body
      const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
      const sessionUrl = `${webAppUrl}/session/${sessionId}`;
      const fullBody = body.body + `\n\n---\n*Created with [Open-Inspect](${sessionUrl})*`;

      // Create the PR using GitHub API (using the prompting user's token)
      const prResult = await createPullRequest(
        {
          accessTokenEncrypted: user.github_access_token_encrypted!,
          owner: session.repo_owner,
          repo: session.repo_name,
          title: body.title,
          body: fullBody,
          head: headBranch,
          base: baseBranch,
        },
        this.env.TOKEN_ENCRYPTION_KEY
      );

      // Store the PR as an artifact
      const artifactId = generateId();
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO artifacts (id, type, url, metadata, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        artifactId,
        "pr",
        prResult.htmlUrl,
        JSON.stringify({
          number: prResult.number,
          state: prResult.state,
          head: headBranch,
          base: baseBranch,
        }),
        now
      );

      // Update session with branch name
      this.sql.exec(`UPDATE session SET branch_name = ? WHERE id = ?`, headBranch, session.id);

      // Broadcast PR creation to all clients
      this.broadcast({
        type: "artifact_created",
        artifact: {
          id: artifactId,
          type: "pr",
          url: prResult.htmlUrl,
          prNumber: prResult.number,
        },
      });

      return Response.json({
        prNumber: prResult.number,
        prUrl: prResult.htmlUrl,
        state: prResult.state,
      });
    } catch (error) {
      console.error("[DO] PR creation failed:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create PR" },
        { status: 500 }
      );
    }
  }

  /**
   * Generate a WebSocket authentication token for a participant.
   *
   * This endpoint:
   * 1. Creates or updates a participant record
   * 2. Generates a 256-bit random token
   * 3. Stores the SHA-256 hash in the participant record
   * 4. Optionally stores encrypted GitHub token for PR creation
   * 5. Returns the plain token to the caller
   */
  private async handleGenerateWsToken(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string;
      githubUserId?: string;
      githubLogin?: string;
      githubName?: string;
      githubEmail?: string;
      githubTokenEncrypted?: string | null; // Encrypted GitHub OAuth token for PR creation
      githubTokenExpiresAt?: number | null; // Token expiry timestamp in milliseconds
    };

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const now = Date.now();

    // Check if participant exists
    let participant = this.getParticipantByUserId(body.userId);

    if (participant) {
      // Update existing participant with any new info
      // Use COALESCE for token fields to only update if new values provided
      this.sql.exec(
        `UPDATE participants SET
           github_user_id = COALESCE(?, github_user_id),
           github_login = COALESCE(?, github_login),
           github_name = COALESCE(?, github_name),
           github_email = COALESCE(?, github_email),
           github_access_token_encrypted = COALESCE(?, github_access_token_encrypted),
           github_token_expires_at = COALESCE(?, github_token_expires_at)
         WHERE id = ?`,
        body.githubUserId ?? null,
        body.githubLogin ?? null,
        body.githubName ?? null,
        body.githubEmail ?? null,
        body.githubTokenEncrypted ?? null,
        body.githubTokenExpiresAt ?? null,
        participant.id
      );
    } else {
      // Create new participant with optional GitHub token
      const id = generateId();
      this.sql.exec(
        `INSERT INTO participants (id, user_id, github_user_id, github_login, github_name, github_email, github_access_token_encrypted, github_token_expires_at, role, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.userId,
        body.githubUserId ?? null,
        body.githubLogin ?? null,
        body.githubName ?? null,
        body.githubEmail ?? null,
        body.githubTokenEncrypted ?? null,
        body.githubTokenExpiresAt ?? null,
        "member",
        now
      );
      participant = this.getParticipantByUserId(body.userId)!;
    }

    // Generate a new WebSocket token (32 bytes = 256 bits)
    const plainToken = generateId(32);
    const tokenHash = await hashToken(plainToken);

    // Store the hash (invalidates any previous token)
    this.sql.exec(
      `UPDATE participants SET ws_auth_token = ?, ws_token_created_at = ? WHERE id = ?`,
      tokenHash,
      now,
      participant.id
    );

    console.log(`[DO] Generated WS token for participant ${participant.id} (user: ${body.userId})`);

    return Response.json({
      token: plainToken,
      participantId: participant.id,
    });
  }

  /**
   * Get participant by WebSocket token hash.
   */
  private getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE ws_auth_token = ?`, tokenHash);
    const rows = result.toArray() as unknown as ParticipantRow[];
    return rows[0] ?? null;
  }

  /**
   * Handle archive session request.
   * Sets session status to "archived" and broadcasts to all clients.
   * Only session participants are authorized to archive.
   */
  private async handleArchive(request: Request): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify user is a participant (fail closed)
    let body: { userId?: string };
    try {
      body = (await request.json()) as { userId?: string };
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const participant = this.getParticipantByUserId(body.userId);
    if (!participant) {
      return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
    }

    const now = Date.now();
    this.sql.exec(
      `UPDATE session SET status = 'archived', updated_at = ? WHERE id = ?`,
      now,
      session.id
    );

    // Broadcast status change to all connected clients
    this.broadcast({
      type: "session_status",
      status: "archived",
    });

    return Response.json({ status: "archived" });
  }

  /**
   * Handle unarchive session request.
   * Restores session status to "active" and broadcasts to all clients.
   * Only session participants are authorized to unarchive.
   */
  private async handleUnarchive(request: Request): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Verify user is a participant (fail closed)
    let body: { userId?: string };
    try {
      body = (await request.json()) as { userId?: string };
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const participant = this.getParticipantByUserId(body.userId);
    if (!participant) {
      return Response.json({ error: "Not authorized to unarchive this session" }, { status: 403 });
    }

    const now = Date.now();
    this.sql.exec(
      `UPDATE session SET status = 'active', updated_at = ? WHERE id = ?`,
      now,
      session.id
    );

    // Broadcast status change to all connected clients
    this.broadcast({
      type: "session_status",
      status: "active",
    });

    return Response.json({ status: "active" });
  }
}
