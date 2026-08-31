import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import {
  redactSessionSnapshotSandboxAccess,
  type ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import {
  WS_AUTHORIZATION_REVOKED_REASON,
  WS_CLOSE_AUTHORIZATION_REVOKED,
  WS_CLOSE_INTERNAL_ERROR,
} from "@open-inspect/shared/types/websocket";
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
import { WS_AUTHORIZATION_LEASE_MS } from "./authorization-lease";

/**
 * Maximum age of a WebSocket authentication token (in milliseconds).
 * Tokens older than this are rejected with close code 4001, forcing
 * the client to fetch a fresh token on reconnect.
 */
const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Dependencies for authenticating sockets and validating browser authorization. */
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
  /** Resolve a user's current authorization at the start of a subscription or command. */
  resolveAuthorization: (userId: string) => Promise<AuthorizationResolution>;
  /** The session-scoped logger; upgrade/subscribe paths also receive request-scoped children. */
  log: Logger;
}

type AuthorizationResolution =
  | { kind: "valid"; authorization: EffectiveAuthorization }
  | { kind: "rejected" | "unavailable" };

export type ClientCommandAuthorization = "allowed" | "denied" | "unavailable";

/**
 * Admits connections to the session: sandbox WebSocket upgrades (token +
 * lifecycle-state guards, re-checked after the non-storage token-hash await),
 * client subscriptions (token TTL, permission checks, authorization leases,
 * snapshot handoff), and post-hibernation client identity recovery.
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

  /** Validate the client token and current permission before granting an authorization lease. */
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

      if (!participant.canonical_user_id) {
        wsManager.close(ws, WS_CLOSE_AUTHORIZATION_REVOKED, WS_AUTHORIZATION_REVOKED_REASON);
        return;
      }

      // Authorization is intentionally sampled once at the start of this
      // subscription request. A concurrent role change takes effect when this
      // bounded lease expires, not midway through an in-flight request.
      const authorization = await this.deps.resolveAuthorization(participant.canonical_user_id);
      if (
        authorization.kind !== "valid" ||
        !authorization.authorization.permissions.includes("sessions.read")
      ) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason:
            authorization.kind === "unavailable"
              ? "authorization_unavailable"
              : "authorization_denied",
          participant_id: participant.id,
          user_id: participant.canonical_user_id,
        });
        if (authorization.kind === "unavailable") {
          wsManager.close(ws, WS_CLOSE_INTERNAL_ERROR, "Authorization temporarily unavailable");
        } else {
          wsManager.close(ws, WS_CLOSE_AUTHORIZATION_REVOKED, WS_AUTHORIZATION_REVOKED_REASON);
        }
        return;
      }
      const authorizationExpiresAt = Date.now() + WS_AUTHORIZATION_LEASE_MS;

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

      const enrichment = await this.deps.snapshotReader.resolveSessionSnapshotEnrichment();
      const clientInfo: ClientInfo = {
        participantId: participant.id,
        userId: participant.canonical_user_id ?? participant.user_id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.deps.scmProviderName),
        status: "active",
        lastSeen: Date.now(),
        clientId: data.clientId,
        authorizationExpiresAt,
        ws,
      };

      try {
        const activated = await wsManager.activateClient(ws, clientInfo, () =>
          this.completeClientSubscription(
            ws,
            clientInfo,
            enrichment,
            authorization.authorization.permissions.includes("sessions.sandbox_access")
          )
        );
        if (!activated) {
          wsManager.close(ws, 4009, "Session synchronization failed");
          return;
        }
      } catch (error) {
        log.error("Failed to activate synchronized WebSocket client", {
          participant_id: participant.id,
          user_id: participant.user_id,
          error: error instanceof Error ? error : String(error),
        });
        wsManager.close(ws, WS_CLOSE_INTERNAL_ERROR, "Session activation failed");
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
    enrichment: Parameters<SessionSnapshotReader["readSessionSnapshot"]>[0],
    canAccessSandbox: boolean
  ): boolean {
    const { wsManager, snapshotReader } = this.deps;
    const snapshot = snapshotReader.readSessionSnapshot(enrichment);
    if (!snapshot) return false;

    const authorizedSnapshot = canAccessSandbox
      ? snapshot
      : redactSessionSnapshotSandboxAccess(snapshot);
    if (
      !wsManager.send(ws, {
        type: "subscribed",
        ...authorizedSnapshot,
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

    return true;
  }

  /** Samples one permission before dispatching a WebSocket command. */
  async authorizeClientCommand(
    userId: string,
    permission: PermissionId
  ): Promise<ClientCommandAuthorization> {
    const resolution = await this.deps.resolveAuthorization(userId);
    if (resolution.kind === "unavailable") return "unavailable";
    if (resolution.kind === "rejected") return "denied";
    if (resolution.kind !== "valid") return "denied";
    return resolution.authorization.permissions.includes(permission) ? "allowed" : "denied";
  }

  /** Return authorized client state, recovering an unexpired lease after hibernation. */
  getClientInfo(ws: WebSocket): ClientInfo | null {
    const { wsManager, log } = this.deps;
    const lookup = wsManager.lookupClient(ws);
    if (lookup.kind === "cached") return lookup.client;
    if (lookup.kind === "authorization_rejected") return null;
    if (lookup.kind === "missing") {
      log.warn("No client mapping found after hibernation, closing WebSocket");
      wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }
    const { mapping } = lookup;
    log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.canonical_user_id ?? mapping.user_id,
      name: resolveParticipantName(mapping),
      avatar: getAvatarUrl(mapping.scm_login, this.deps.scmProviderName),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      authorizationExpiresAt: mapping.authorization_expires_at,
      ws,
    };

    wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }
}
