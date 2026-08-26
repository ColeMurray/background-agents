import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { hashToken } from "../auth/crypto";
import type { Logger } from "../logger";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import type { SandboxLifecycleManager } from "../sandbox/lifecycle/manager";
import type { SourceControlProviderName } from "../source-control";
import type { BackgroundTasks } from "../platform-ports";
import type { ClientInfo } from "../types";
import { isValidSandboxToken } from "./sandbox-access";
import { resolveParticipantName } from "./participant-name";
import { getAvatarUrl, type ParticipantService } from "./participant-service";
import type { PresenceService } from "./presence-service";
import type { SessionMessageQueue } from "./message-queue";
import type { SessionMessenger } from "./messenger";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionSnapshotReader } from "./snapshot-reader";
import type { SessionWebSocketManager } from "./websocket-manager";

/**
 * Maximum age of a WebSocket authentication token (in milliseconds).
 * Tokens older than this are rejected with close code 4001, forcing
 * the client to fetch a fresh token on reconnect.
 */
const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionConnectionAuthenticatorDeps {
  wsManager: SessionWebSocketManager;
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  lifecycleManager: SandboxLifecycleManager;
  messenger: SessionMessenger;
  backgroundTasks: BackgroundTasks;
  messageQueue: Pick<SessionMessageQueue, "processMessageQueue">;
  participantService: ParticipantService;
  presenceService: PresenceService;
  snapshotReader: SessionSnapshotReader;
  schedulePullRequestRefresh: (trigger: "open" | "manual") => void;
  scmProviderName: SourceControlProviderName;
  /** The session-scoped logger; upgrade/subscribe paths also receive request-scoped children. */
  log: Logger;
}

/**
 * Admits connections to the session: sandbox WebSocket upgrades (token +
 * lifecycle-state guards, re-checked after the non-storage token-hash await),
 * client subscriptions (token TTL, snapshot handoff), and post-hibernation
 * client identity recovery.
 */
export class SessionConnectionAuthenticator {
  constructor(private readonly deps: SessionConnectionAuthenticatorDeps) {}

  /**
   * Handle WebSocket upgrade request. `log` is the request-scoped logger.
   */
  async handleWebSocketUpgrade(request: Request, url: URL, log: Logger): Promise<Response> {
    const {
      wsManager,
      sessionCoreRepository,
      sandboxRepository,
      lifecycleManager,
      messenger,
      backgroundTasks,
      messageQueue,
    } = this.deps;
    log.debug("WebSocket upgrade requested");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      const wsStartTime = Date.now();
      const authHeader = request.headers.get("Authorization");
      const sandboxId = request.headers.get("X-Sandbox-ID");
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      // Get expected values from DB
      const sandbox = sandboxRepository.getSandbox();
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Validate sandbox ID first (catches stale sandboxes reconnecting after restore)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "sandbox_id_mismatch",
          expected_sandbox_id: expectedSandboxId,
          sandbox_id: sandboxId,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
      }

      // Validate auth token
      const tokenMatches = await isValidSandboxToken(providedToken, sandbox);
      if (!tokenMatches) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "token_mismatch",
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Reject connection if the session itself is closed for good. Narrower
      // than "not active": `completed` and `failed` sessions are idle, not
      // over — warm-on-typing spawns a sandbox for one before the follow-up
      // prompt arrives, and rejecting its bridge stranded that prompt.
      //
      // Read after authentication, not before: token hashing is a non-storage
      // await, so the input gate lets a cancel or archive land while this
      // request is suspended. Admission needs a fresh, synchronous read.
      const currentSession = sessionCoreRepository.getSession();
      if (currentSession && !isSessionPromptable(currentSession.status)) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "session_terminal",
          session_status: currentSession.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Session is terminal", { status: 410 });
      }

      const currentSandbox = sandboxRepository.getSandbox();
      // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
      // still connect after a slow boot and self-heal by becoming ready.
      if (currentSandbox && isSandboxReconnectBlockedStatus(currentSandbox.status)) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "sandbox_stopped",
          sandbox_status: currentSandbox.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Sandbox is stopped", { status: 410 });
      }
      if (
        currentSandbox?.modal_sandbox_id !== expectedSandboxId ||
        currentSandbox?.auth_token_hash !== sandbox?.auth_token_hash ||
        currentSandbox?.auth_token !== sandbox?.auth_token
      ) {
        return new Response("Forbidden: Sandbox credentials changed", { status: 403 });
      }

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const { client, server } = wsManager.createUpgradeSockets();

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        // The lifecycle manager publishes access after any pending provider
        // startup has persisted its URLs and credentials.
        const accessIsPersisted = !lifecycleManager.isProviderStartupPending();
        const { replaced } = wsManager.acceptAndSetSandboxSocket(server, sandboxId ?? undefined);
        // Notify manager that sandbox connected so it can reset the spawning flag
        lifecycleManager.onSandboxConnected();
        sandboxRepository.updateSandboxStatus("ready");
        messenger.broadcast({ type: "sandbox_status", status: "ready" });
        if (accessIsPersisted) {
          messenger.broadcast({ type: "sandbox_access_changed" });
        }

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        lifecycleManager.updateLastActivity(now);
        sandboxRepository.updateSandboxHeartbeat(now);
        await lifecycleManager.scheduleInactivityCheck();

        log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        backgroundTasks.submit(() => messageQueue.processMessageQueue(), {
          name: "message_queue.process",
        });
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        wsManager.acceptClientSocket(server, wsId);
        backgroundTasks.submit(() => wsManager.enforceAuthTimeout(server, wsId), {
          name: "websocket.enforce_auth_timeout",
          context: { ws_id: wsId },
        });
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle client subscription with token validation.
   */
  async handleSubscribe(
    ws: WebSocket,
    data: {
      token: string;
      clientId: string;
    }
  ): Promise<void> {
    const { wsManager, participantService, presenceService, log } = this.deps;
    // Validate the WebSocket auth token
    if (!data.token) {
      log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      wsManager.close(ws, 4001, "Authentication required");
      return;
    }

    if (wsManager.isClientAuthenticated(ws) || wsManager.isClientSynchronizing(ws)) {
      wsManager.close(ws, 4003, "Already subscribed");
      return;
    }
    wsManager.setClientSynchronizing(ws, true);

    try {
      // Hash the incoming token and look up participant
      const tokenHash = await hashToken(data.token);
      const participant = participantService.getByWsTokenHash(tokenHash);

      if (!participant) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason: "invalid_token",
        });
        wsManager.close(ws, 4001, "Invalid authentication token");
        return;
      }

      // Reject tokens older than the TTL
      if (
        participant.ws_token_created_at === null ||
        Date.now() - participant.ws_token_created_at > WS_TOKEN_TTL_MS
      ) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason: "token_expired",
          participant_id: participant.id,
          user_id: participant.user_id,
        });
        wsManager.close(ws, 4001, "Token expired");
        return;
      }

      log.info("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "success",
        participant_id: participant.id,
        user_id: participant.user_id,
        client_id: data.clientId,
      });

      // Build client info from participant data
      const clientInfo: ClientInfo = {
        participantId: participant.id,
        userId: participant.canonical_user_id ?? participant.user_id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.deps.scmProviderName),
        status: "active",
        lastSeen: Date.now(),
        clientId: data.clientId,
        ws,
      };

      const enrichment = await this.deps.snapshotReader.resolveSessionSnapshotEnrichment();
      if (!this.completeClientSubscription(ws, clientInfo, enrichment)) {
        wsManager.close(ws, 4009, "Session synchronization failed");
        return;
      }

      presenceService.sendPresence(ws);
      presenceService.broadcastPresence();
      this.deps.schedulePullRequestRefresh("open");
    } finally {
      wsManager.setClientSynchronizing(ws, false);
    }
  }

  /**
   * Finish the snapshot-to-stream handoff synchronously. Keeping the final read,
   * send, and registration in a non-async method makes the no-await invariant
   * structural rather than a convention inside the async authentication flow.
   */
  private completeClientSubscription(
    ws: WebSocket,
    client: ClientInfo,
    enrichment: Parameters<SessionSnapshotReader["readSessionSnapshot"]>[0]
  ): boolean {
    const { wsManager, snapshotReader, log } = this.deps;
    const snapshot = snapshotReader.readSessionSnapshot(enrichment);
    if (!snapshot) return false;

    if (
      !wsManager.send(ws, {
        type: "subscribed",
        ...snapshot,
        participantId: client.participantId,
        participant: {
          participantId: client.participantId,
          userId: client.userId,
          name: client.name,
          avatar: client.avatar,
        },
      } satisfies ServerMessage)
    ) {
      return false;
    }

    wsManager.setClient(ws, client);
    const parsed = wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      wsManager.persistClientMapping(parsed.wsId, client.participantId, client.clientId);
      log.debug("Stored ws_client_mapping", {
        ws_id: parsed.wsId,
        participant_id: client.participantId,
      });
    }
    return true;
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  getClientInfo(ws: WebSocket): ClientInfo | null {
    const { wsManager, log } = this.deps;
    // 1. In-memory cache (manager)
    const cached = wsManager.getClient(ws);
    if (cached) return cached;

    // 2. DB recovery (manager handles tag parsing + DB lookup)
    const mapping = wsManager.recoverClientMapping(ws);
    if (!mapping) {
      log.warn("No client mapping found after hibernation, closing WebSocket");
      wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }

    // 3. Build ClientInfo
    log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.canonical_user_id ?? mapping.user_id,
      name: resolveParticipantName(mapping),
      avatar: getAvatarUrl(mapping.scm_login, this.deps.scmProviderName),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      ws,
    };

    // 4. Re-cache
    wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }
}
