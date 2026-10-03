import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import {
  checkSessionAccess,
  type AccessDenialReason,
  type AccessDecision,
  type SessionAction,
  type SessionAccessRow,
  type SessionCapabilities,
  type SessionViewer,
} from "@open-inspect/shared";
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
import type { SandboxAttachment } from "../sandbox/lifecycle/ports";
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
import type { SandboxStateReader, SandboxRuntimeFacts } from "./sandbox-ports";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionSnapshotReader } from "./snapshot-reader";
import type { SandboxRow } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";
import { WS_AUTHORIZATION_LEASE_MS } from "./authorization-lease";
import { canManageSessionBudget } from "./budget-authorization";
import {
  legacyPermissionForAction,
  resolverDecides,
  type TeamsEnforcementMode,
} from "../authorization/teams-enforcement";
import type { ClientCommandAuthorization } from "./message-router";
import { effectiveSessionCapabilities } from "../authorization/session-admission";

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
  sandboxRepository: SandboxStateReader & Pick<SandboxRuntimeFacts, "updateSandboxHeartbeat">;
  lifecycleManager: SandboxAttachment;
  messenger: SessionMessenger;
  backgroundTasks: BackgroundTasks;
  messageQueue: Pick<SessionMessageQueue, "processMessageQueue">;
  participantService: ParticipantService;
  presenceService: PresenceService;
  snapshotReader: SessionSnapshotReader;
  schedulePullRequestRefresh: (trigger: "open" | "manual") => void;
  scmProviderName: SourceControlProviderName;
  /** Resolve the current D1 session scope and user's authorization on every gated action. */
  resolveSessionViewer: (
    userId: string,
    options?: { includeMemberships?: boolean }
  ) => Promise<SessionViewerResolution>;
  auditPrivateBreakGlass: (userId: string, row: SessionAccessRow) => Promise<void>;
  auditShadowDenied: (
    userId: string,
    row: SessionAccessRow,
    reason: AccessDenialReason,
    connectionId: string
  ) => Promise<void>;
  /** The session-scoped logger; upgrade/subscribe paths also receive request-scoped children. */
  log: Logger;
}

type SessionViewerResolution =
  | {
      kind: "valid";
      mode: TeamsEnforcementMode;
      authorization: EffectiveAuthorization;
      viewer: SessionViewer;
      row: SessionAccessRow;
    }
  | { kind: "rejected" | "unavailable" };

interface SandboxAdmission {
  sandboxId: string | null;
  createdAt: number;
  authTokenHash: string | null;
  authToken: string | null;
}

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
  private readonly shadowDenials = new WeakMap<SessionWebSocket, Set<string>>();

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
    if (!tokenMatches || !sandbox) {
      log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "auth_failed",
        reject_reason: "token_mismatch",
        duration_ms: Date.now() - wsStartTime,
      });
      return reject("Unauthorized: Invalid auth token", 401);
    }

    // A refused bridge exits and its sandbox shuts itself down. While a save
    // still needs this sandbox, the bridge is told to retry instead; the save
    // stops the sandbox once it is done with it.
    const refusedReconnect = (): "retry" | "exit" => {
      const current = sandboxRepository.getSandbox();
      return current !== null &&
        current.modal_sandbox_id === expectedSandboxId &&
        current.created_at === sandbox.created_at
        ? this.deps.lifecycleManager.onRefusedReconnect()
        : "exit";
    };

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
      // An archived session's sandbox is being saved; a cancelled one is destroyed.
      const instruction = currentSession.status === "archived" ? refusedReconnect() : "exit";
      log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "rejected",
        reject_reason: instruction === "retry" ? "sandbox_preserving" : "session_terminal",
        session_status: currentSession.status,
        duration_ms: Date.now() - wsStartTime,
      });
      return instruction === "retry"
        ? reject("Sandbox is being saved", 503)
        : reject("Session is terminal", 410);
    }

    const currentSandbox = sandboxRepository.getSandbox();
    // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
    // still connect after a slow boot and self-heal by becoming ready.
    if (currentSandbox && isSandboxReconnectBlockedStatus(currentSandbox.status)) {
      const instruction = refusedReconnect();
      log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "rejected",
        reject_reason: instruction === "retry" ? "sandbox_preserving" : "sandbox_stopped",
        sandbox_status: currentSandbox.status,
        duration_ms: Date.now() - wsStartTime,
      });
      return instruction === "retry"
        ? reject("Sandbox is being saved", 503)
        : reject("Sandbox is stopped", 410);
    }
    if (
      !currentSandbox ||
      currentSandbox.modal_sandbox_id !== expectedSandboxId ||
      currentSandbox.created_at !== sandbox.created_at ||
      currentSandbox.auth_token_hash !== sandbox.auth_token_hash ||
      currentSandbox.auth_token !== sandbox.auth_token
    ) {
      return reject("Forbidden: Sandbox credentials changed", 403);
    }

    const admission: SandboxAdmission = {
      sandboxId: currentSandbox.modal_sandbox_id,
      createdAt: currentSandbox.created_at,
      authTokenHash: currentSandbox.auth_token_hash,
      authToken: currentSandbox.auth_token,
    };
    // The success ws.connect event is emitted once the socket is attached.
    return accept("sandbox", (ws) => this.attachSandbox(ws, admission, log));
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
   * Revalidate, prepare, revalidate, commit. The row must still match the
   * generation and credentials authorized before the host handshake. The
   * boot-liveness alarm is the one fallible step, so it runs before any write;
   * the row is checked again after that await. Everything after the second
   * check is synchronous, so the heartbeat, socket and row's move to
   * `connecting` land together.
   *
   * Attach is not readiness. The bridge connects ahead of the repository
   * boot and the harness, so this neither writes `ready`, stamps activity
   * nor arms the inactivity reaper; the runtime's `ready` event does all of
   * that (`SandboxRuntimeEventHandler.handleReady`). The one exception is a
   * bridge reconnecting to a sandbox that is already ready (a bridge restart,
   * a hibernation wake): the queue is pumped so a prompt that arrived while
   * the socket was down does not wait for the user. The heartbeat stamp
   * doubles as the "this generation has connected" mark the spawn decision
   * and the connect watchdog read.
   */
  private async attachSandbox(
    ws: SessionWebSocket,
    admission: SandboxAdmission,
    log: Logger
  ): Promise<void> {
    const { wsManager, sandboxRepository, lifecycleManager, messenger, backgroundTasks } =
      this.deps;

    const generation = { sandboxId: admission.sandboxId, createdAt: admission.createdAt };
    const rejectIfReplaced = (): boolean => {
      const current = sandboxRepository.getSandbox();
      if (matchesAdmission(current, admission)) return false;
      log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "generation_replaced",
        sandbox_id: admission.sandboxId,
        admitted_sandbox_id: admission.sandboxId,
        current_sandbox_id: current?.modal_sandbox_id ?? null,
      });
      wsManager.close(ws, 4003, "Sandbox generation replaced");
      return true;
    };

    const now = Date.now();
    if (rejectIfReplaced()) return;
    await lifecycleManager.scheduleDisconnectCheck();
    if (rejectIfReplaced()) return;
    sandboxRepository.updateSandboxHeartbeat(now);

    // The lifecycle manager publishes access after any pending provider
    // startup has persisted its URLs and credentials.
    const accessIsPersisted = !lifecycleManager.isProviderStartupPending();
    const { replaced } = wsManager.acceptAndSetSandboxSocket(ws, admission.sandboxId ?? undefined);
    // Notify manager that sandbox connected so it can reset the spawning flag
    lifecycleManager.onSandboxConnected();
    lifecycleManager.onSandboxSocketAttached(generation);
    if (accessIsPersisted) {
      messenger.broadcast({ type: "sandbox_access_changed" });
    }

    log.info("ws.connect", {
      event: "ws.connect",
      ws_type: "sandbox",
      outcome: "success",
      sandbox_id: admission.sandboxId,
      replaced_existing: replaced,
      duration_ms: Date.now() - now,
    });

    if (wsManager.getSandboxCommandTarget().kind === "dispatch") {
      backgroundTasks.submit(() => this.deps.messageQueue.processMessageQueue(), {
        name: "message_queue.process",
      });
    }
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
      const resolution = await this.deps.resolveSessionViewer(participant.canonical_user_id, {
        includeMemberships: true,
      });
      const read = resolution.kind === "valid" ? this.decide(resolution, "read") : null;
      if (resolution.kind !== "valid" || !read?.allowed) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "client",
          outcome: "auth_failed",
          reject_reason:
            resolution.kind === "unavailable"
              ? "authorization_unavailable"
              : "authorization_denied",
          participant_id: participant.id,
          user_id: participant.canonical_user_id,
        });
        if (resolution.kind === "unavailable") {
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

      if (read.audit === "session.private_break_glass") {
        try {
          await this.deps.auditPrivateBreakGlass(participant.canonical_user_id, resolution.row);
        } catch (error) {
          log.error("WebSocket break-glass audit failed", {
            user_id: participant.canonical_user_id,
            error: error instanceof Error ? error : String(error),
          });
          wsManager.close(ws, WS_CLOSE_INTERNAL_ERROR, "Authorization temporarily unavailable");
          return;
        }
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
            effectiveSessionCapabilities(resolution.viewer, resolution.row, resolution.mode),
            canManageSessionBudget(resolution.row.ownerUserId, resolution.authorization)
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
      await this.observeShadowReadDenial(ws, resolution);
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
    capabilities: SessionCapabilities,
    canManageBudget: boolean
  ): boolean {
    const { wsManager, snapshotReader } = this.deps;
    const snapshot = snapshotReader.readSessionSnapshot(enrichment);
    if (!snapshot) return false;

    const authorizedSnapshot = capabilities.canSandbox
      ? snapshot
      : redactSessionSnapshotSandboxAccess(snapshot);
    if (
      !wsManager.send(ws, {
        type: "subscribed",
        ...authorizedSnapshot,
        session: { ...authorizedSnapshot.session, capabilities },
        participantId: client.participantId,
        participant: {
          participantId: client.participantId,
          userId: client.userId,
          name: client.name,
          avatar: client.avatar,
        },
        canManageBudget,
      } satisfies ServerMessage)
    ) {
      return false;
    }

    return true;
  }

  /** Samples the current D1 scope and access before dispatching a WebSocket command. */
  async authorizeClientCommand(
    ws: SessionWebSocket,
    userId: string,
    action: SessionAction
  ): Promise<ClientCommandAuthorization> {
    const resolution = await this.deps.resolveSessionViewer(userId);
    if (resolution.kind === "unavailable") return { kind: "unavailable" };
    if (resolution.kind !== "valid" || !this.decide(resolution, "read").allowed) {
      this.deps.wsManager.removeClient(ws);
      this.deps.wsManager.close(
        ws,
        WS_CLOSE_AUTHORIZATION_REVOKED,
        WS_AUTHORIZATION_REVOKED_REASON
      );
      return { kind: "revoked" };
    }
    await this.observeShadowReadDenial(ws, resolution);
    const decision = this.decide(resolution, action);
    return decision.allowed ? { kind: "allowed" } : { kind: "denied", reason: decision.reason };
  }

  /** Observe only allowed reads; a hypothetical denial must never revoke the lease. */
  private async observeShadowReadDenial(
    ws: SessionWebSocket,
    resolution: Extract<SessionViewerResolution, { kind: "valid" }>
  ): Promise<void> {
    if (resolution.mode !== "shadow") return;
    try {
      const decision = checkSessionAccess(resolution.viewer, resolution.row, "read");
      if (decision.allowed) return;
      const key = JSON.stringify([resolution.row.id, decision.reason]);
      let observed = this.shadowDenials.get(ws);
      if (observed?.has(key)) return;
      const connection = this.deps.wsManager.classify(ws);
      if (connection.kind !== "client" || !connection.wsId) {
        throw new Error("Missing WebSocket ID for shadow audit");
      }
      if (!observed) {
        observed = new Set();
        this.shadowDenials.set(ws, observed);
      }
      // Reserve before awaiting, including failed writes, to avoid command/retry storms.
      observed.add(key);
      await this.deps.auditShadowDenied(
        resolution.authorization.userId,
        resolution.row,
        decision.reason,
        connection.wsId
      );
    } catch (error) {
      this.deps.log.error("WebSocket shadow denial audit failed", {
        user_id: resolution.authorization.userId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private decide(
    resolution: Extract<SessionViewerResolution, { kind: "valid" }>,
    action: SessionAction
  ): AccessDecision {
    if (resolverDecides(resolution.mode, resolution.row, action)) {
      return checkSessionAccess(resolution.viewer, resolution.row, action);
    }
    return resolution.authorization.permissions.includes(legacyPermissionForAction(action))
      ? { allowed: true }
      : { allowed: false, reason: "missing_permission" };
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

function matchesAdmission(row: SandboxRow | null, admission: SandboxAdmission): boolean {
  return (
    row !== null &&
    row.modal_sandbox_id === admission.sandboxId &&
    row.created_at === admission.createdAt &&
    row.auth_token_hash === admission.authTokenHash &&
    row.auth_token === admission.authToken
  );
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
