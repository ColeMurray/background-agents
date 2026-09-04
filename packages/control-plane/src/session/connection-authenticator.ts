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
import type { BackgroundTasks, SessionWebSocket } from "../platform-ports";
import type { ClientInfo } from "../types";
import { isValidSandboxToken } from "./sandbox-access";
import { requestLogger } from "./request-logger";
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
 * The outcome of authenticating a WebSocket upgrade. The session decides;
 * the host completes the handshake because only it can produce a socket,
 * then hands the server-side socket to `attach`. An accepted decision is the
 * only way to attach, and it attaches exactly once: the guards were evaluated
 * against the state at decision time, so attach directly after authorizing.
 */
export type UpgradeDecision =
  | {
      kind: "accept";
      role: "sandbox" | "client";
      /** Adopt the host's socket for this upgrade and run the connection's side effects. */
      attach(ws: SessionWebSocket): Promise<void>;
    }
  | { kind: "reject"; response: Response };

/** Admission of WebSocket upgrades, as the host drives it. */
export interface SessionUpgradeAdmission {
  authorize(request: Request): Promise<UpgradeDecision>;
}

/**
 * Admits connections to the session: sandbox WebSocket upgrades (token +
 * lifecycle-state guards, re-checked after the non-storage token-hash await),
 * client subscriptions (token TTL, permission checks, authorization leases,
 * snapshot handoff), and post-hibernation client identity recovery.
 */
export class SessionConnectionAuthenticator implements SessionUpgradeAdmission {
  constructor(private readonly deps: SessionConnectionAuthenticatorDeps) {}

  /**
   * Decide a WebSocket upgrade. Every guard runs here; a rejection carries
   * the response the host returns, an acceptance carries the attachment.
   */
  async authorize(request: Request): Promise<UpgradeDecision> {
    const { sessionCoreRepository, sandboxRepository } = this.deps;
    const log = requestLogger(this.deps.log, request);
    log.debug("WebSocket upgrade requested");
    const url = new URL(request.url);
    const isSandbox = url.searchParams.get("type") === "sandbox";
    if (!isSandbox) {
      const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return accept("client", (ws) => this.attachClient(ws, wsId));
    }

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
      return reject("Forbidden: Wrong sandbox ID", 403);
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
      return reject("Unauthorized: Invalid auth token", 401);
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
      return reject("Session is terminal", 410);
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
      return reject("Sandbox is stopped", 410);
    }
    if (
      currentSandbox?.modal_sandbox_id !== expectedSandboxId ||
      currentSandbox?.auth_token_hash !== sandbox?.auth_token_hash ||
      currentSandbox?.auth_token !== sandbox?.auth_token
    ) {
      return reject("Forbidden: Sandbox credentials changed", 403);
    }

    // The success ws.connect event is emitted once the socket is attached.
    return accept("sandbox", (ws) => this.attachSandbox(ws, sandboxId, log));
  }

  private attachClient(ws: SessionWebSocket, wsId: string): void {
    const { wsManager, backgroundTasks } = this.deps;
    wsManager.acceptClientSocket(ws, wsId);
    backgroundTasks.submit(() => wsManager.enforceAuthTimeout(ws, wsId), {
      name: "websocket.enforce_auth_timeout",
      context: { ws_id: wsId },
    });
  }

  /**
   * Prepare, then commit. The inactivity alarm is the one fallible step, so
   * it runs first: a failure leaves the previous bridge in place and nothing
   * published. Everything after the await is synchronous, so the new socket,
   * the ready status, and the broadcasts land together.
   */
  private async attachSandbox(
    ws: SessionWebSocket,
    sandboxId: string | null,
    log: Logger
  ): Promise<void> {
    const {
      wsManager,
      sandboxRepository,
      lifecycleManager,
      messenger,
      backgroundTasks,
      messageQueue,
    } = this.deps;

    const now = Date.now();
    lifecycleManager.updateLastActivity(now);
    sandboxRepository.updateSandboxHeartbeat(now);
    await lifecycleManager.scheduleInactivityCheck();

    // The lifecycle manager publishes access after any pending provider
    // startup has persisted its URLs and credentials.
    const accessIsPersisted = !lifecycleManager.isProviderStartupPending();
    const { replaced } = wsManager.acceptAndSetSandboxSocket(ws, sandboxId ?? undefined);
    // Notify manager that sandbox connected so it can reset the spawning flag
    lifecycleManager.onSandboxConnected();
    sandboxRepository.updateSandboxStatus("ready");
    messenger.broadcast({ type: "sandbox_status", status: "ready" });
    if (accessIsPersisted) {
      messenger.broadcast({ type: "sandbox_access_changed" });
    }

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
  }

  /** Validate the client token and current permission before granting an authorization lease. */
  async handleSubscribe(
    ws: SessionWebSocket,
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
    ws: SessionWebSocket,
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
  getClientInfo(ws: SessionWebSocket): ClientInfo | null {
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
    };

    wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }
}

function reject(body: string, status: number): UpgradeDecision {
  return { kind: "reject", response: new Response(body, { status }) };
}

/** An accepted decision whose attachment can run once. */
function accept(
  role: "sandbox" | "client",
  attach: (ws: SessionWebSocket) => void | Promise<void>
): UpgradeDecision {
  let attached = false;
  return {
    kind: "accept",
    role,
    attach: async (ws) => {
      if (attached) throw new Error("WebSocket upgrade already attached");
      attached = true;
      await attach(ws);
    },
  };
}
