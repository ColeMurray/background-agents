import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared";
import type {
  ServerMessage,
  SessionBootstrap,
  SessionDelta,
  SessionViewEvent,
} from "@open-inspect/shared/types/server-messages";
import { toUiArtifact } from "./artifact-metadata";
import { collapseReplayTokenEvents, toUiSandboxEvent } from "./event-log";

export interface HistoryCursor {
  timestamp: number;
  id: string;
  sequence?: number;
}

/**
 * Pure projection of the session view built from server messages. The
 * WebSocket transport, token buffering, and SWR cache effects live outside —
 * this reducer only turns already-normalized inputs into the next view state.
 */
export interface SessionSocketState {
  replaying: boolean;
  ready: boolean;
  protocol: "unknown" | "v2" | "legacy";
  lastAppliedRevision: number | null;
  recoveryNonce: number;
  recovering: boolean;
  sync: {
    mode: "resume" | "snapshot";
    targetRevision: number;
    snapshotReceived: boolean;
  } | null;
  sessionState: SessionState | null;
  events: SandboxEvent[];
  viewEvents: SessionViewEvent[];
  participants: ParticipantPresence[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  cursor: HistoryCursor | null;
}

export const initialSessionSocketState: SessionSocketState = {
  replaying: true,
  ready: false,
  protocol: "unknown",
  lastAppliedRevision: null,
  recoveryNonce: 0,
  recovering: false,
  sync: null,
  sessionState: null,
  events: [],
  viewEvents: [],
  participants: [],
  artifacts: [],
  currentParticipantId: null,
  hasMoreHistory: false,
  loadingHistory: false,
  cursor: null,
};

export type SessionSocketAction =
  /** Any server message except sandbox_event, which is normalized first. */
  | { type: "server_message"; message: Exclude<ServerMessage, { type: "sandbox_event" }> }
  /** Live sandbox events, already passed through token buffering. */
  | { type: "events_appended"; events: SandboxEvent[] }
  /** A fetch_history request was sent. */
  | { type: "history_requested" }
  /** A prompt was sent; optimistically mark the session as processing. */
  | { type: "prompt_sent" }
  | { type: "access_loaded"; access: SessionAccessState | null }
  | { type: "protocol_error" }
  /** The socket closed (clean or not). */
  | { type: "socket_closed" };

export interface SessionAccessState {
  codeServerUrl?: string | null;
  codeServerPassword?: string | null;
  ttydUrl?: string | null;
  ttydToken?: string | null;
}

const CLEARED_SANDBOX_ACCESS_STATE = {
  codeServerUrl: undefined,
  codeServerPassword: undefined,
  tunnelUrls: undefined,
  ttydUrl: undefined,
  ttydToken: undefined,
} satisfies Partial<SessionState>;

/** Replace an artifact in place by id, or prepend when it is new. */
function upsertArtifact(artifacts: Artifact[], nextArtifact: Artifact): Artifact[] {
  const existingIndex = artifacts.findIndex((artifact) => artifact.id === nextArtifact.id);
  if (existingIndex === -1) {
    return [nextArtifact, ...artifacts];
  }
  return artifacts.map((artifact, index) => (index === existingIndex ? nextArtifact : artifact));
}

function sortedViewEvents(items: SessionViewEvent[]): SessionViewEvent[] {
  return [...items].sort(
    (a, b) => a.timelineSequence - b.timelineSequence || a.eventId.localeCompare(b.eventId)
  );
}

function upsertViewEvent(
  items: SessionViewEvent[],
  nextItem: SessionViewEvent
): SessionViewEvent[] {
  const existingIndex = items.findIndex((item) => item.eventId === nextItem.eventId);
  if (existingIndex === -1) return sortedViewEvents([...items, nextItem]);
  const next = [...items];
  next[existingIndex] = nextItem;
  return sortedViewEvents(next);
}

function withViewEvents(
  state: SessionSocketState,
  viewEvents: SessionViewEvent[]
): SessionSocketState {
  const sorted = sortedViewEvents(viewEvents);
  return {
    ...state,
    viewEvents: sorted,
    events: sorted.map((item) => toUiSandboxEvent(item.event)),
  };
}

export function createSessionSocketState(bootstrap: SessionBootstrap): SessionSocketState {
  const viewEvents = sortedViewEvents(bootstrap.replay.events);
  return {
    ...initialSessionSocketState,
    replaying: false,
    lastAppliedRevision: bootstrap.viewRevision,
    sessionState: {
      ...bootstrap.state,
      isProcessing: bootstrap.state.isProcessing ?? false,
      totalCost: bootstrap.state.totalCost ?? 0,
    },
    artifacts: bootstrap.artifacts.map(toUiArtifact),
    viewEvents,
    events: viewEvents.map((item) => toUiSandboxEvent(item.event)),
    hasMoreHistory: bootstrap.replay.hasMore,
    cursor: bootstrap.replay.cursor,
  };
}

function protocolError(state: SessionSocketState): SessionSocketState {
  if (state.recovering) return state;
  return {
    ...state,
    ready: false,
    sync: null,
    recoveryNonce: state.recoveryNonce + 1,
    recovering: true,
  };
}

function replaceFromBootstrap(
  state: SessionSocketState,
  bootstrap: SessionBootstrap
): SessionSocketState {
  const replacement = createSessionSocketState(bootstrap);
  return {
    ...replacement,
    protocol: "v2",
    sync: state.sync && { ...state.sync, snapshotReceived: true },
    recoveryNonce: state.recoveryNonce,
    participants: state.participants,
    currentParticipantId: state.currentParticipantId,
  };
}

function applyDelta(state: SessionSocketState, delta: SessionDelta): SessionSocketState {
  let next = state;
  for (const operation of delta.operations) {
    switch (operation.type) {
      case "state_patch":
        next = updateSessionState(next, (previous) => {
          const sandboxStatus = operation.patch.sandboxStatus;
          const clearAccess =
            sandboxStatus === "spawning" ||
            sandboxStatus === "stale" ||
            sandboxStatus === "stopped" ||
            sandboxStatus === "failed";
          return {
            ...previous,
            ...operation.patch,
            ...(clearAccess ? CLEARED_SANDBOX_ACCESS_STATE : {}),
          };
        });
        break;
      case "artifact_upsert":
        next = {
          ...next,
          artifacts: upsertArtifact(next.artifacts, toUiArtifact(operation.artifact)),
        };
        break;
      case "event_upsert":
        next = withViewEvents(next, upsertViewEvent(next.viewEvents, operation.item));
        break;
    }
  }
  return next;
}

/**
 * Apply a `session_branch` update, keeping `state.repositories` and the scalar
 * `branchName` in sync. The invariant is explicit rather than a sole/primary
 * guess:
 *
 * - No hydrated member list → scalar-only, exactly as before.
 * - Exactly one member → the update names the sole repo (the primary): update
 *   it and mirror the scalar.
 * - Multi-repo (`length > 1`) → the message MUST name its member
 *   (repoOwner/repoName); an unscoped or unknown-member update is anomalous
 *   (multi-repo runtimes always echo identity) and is ignored rather than
 *   attributed to the primary. The scalar mirrors only when the named member is
 *   the primary (position 0).
 */
function applySessionBranchUpdate(
  prev: SessionState,
  branchName: string,
  repoOwner: string | undefined,
  repoName: string | undefined
): SessionState {
  const repositories = prev.repositories;

  if (!repositories || repositories.length === 0) {
    return { ...prev, branchName };
  }

  if (repositories.length === 1) {
    return {
      ...prev,
      repositories: [{ ...repositories[0], branchName }],
      branchName,
    };
  }

  // Multi-repo: require identity; ignore an update we can't attribute.
  if (!repoOwner || !repoName) {
    return prev;
  }
  const targetIndex = repositories.findIndex(
    (repo) => repo.repoOwner === repoOwner && repo.repoName === repoName
  );
  if (targetIndex === -1) {
    return prev;
  }

  const updatedRepositories = repositories.map((repo, index) =>
    index === targetIndex ? { ...repo, branchName } : repo
  );
  return {
    ...prev,
    repositories: updatedRepositories,
    ...(targetIndex === 0 ? { branchName } : {}),
  };
}

function updateSessionState(
  state: SessionSocketState,
  update: (prev: SessionState) => SessionState
): SessionSocketState {
  if (!state.sessionState) return state;
  return { ...state, sessionState: update(state.sessionState) };
}

function reduceServerMessage(
  state: SessionSocketState,
  message: Exclude<ServerMessage, { type: "sandbox_event" }>
): SessionSocketState {
  if (state.protocol === "v2" && isLegacyCanonicalMessage(message)) {
    return protocolError(state);
  }
  switch (message.type) {
    case "subscribed":
      // Replace local artifacts and events with the subscribed snapshot so
      // reconnects still clear stale state instead of merging stale client
      // data.
      return {
        ...state,
        replaying: false,
        ready: true,
        protocol: "legacy",
        recovering: false,
        sync: null,
        sessionState: {
          ...message.state,
          // Backward-compatible defaults for older sessions that may omit these.
          isProcessing: message.state.isProcessing ?? false,
          totalCost: message.state.totalCost ?? 0,
        },
        artifacts: message.artifacts.map(toUiArtifact),
        currentParticipantId: message.participantId || state.currentParticipantId,
        events: message.replay
          ? collapseReplayTokenEvents(message.replay.events.map(toUiSandboxEvent))
          : [],
        viewEvents: [],
        hasMoreHistory: message.replay?.hasMore ?? false,
        cursor: message.replay?.cursor ?? null,
        // A fetch_history dropped by a disconnect would otherwise leave this
        // stuck true and block loadOlderEvents after the reconnect.
        loadingHistory: false,
      };

    case "session_sync_started":
      if (
        state.sync ||
        (message.mode === "resume" && state.lastAppliedRevision === null) ||
        message.targetRevision < (state.lastAppliedRevision ?? 0)
      ) {
        return protocolError(state);
      }
      return {
        ...state,
        ready: false,
        protocol: "v2",
        recovering: false,
        sync: {
          mode: message.mode,
          targetRevision: message.targetRevision,
          snapshotReceived: false,
        },
      };

    case "session_snapshot":
      if (
        !state.sync ||
        state.sync.mode !== "snapshot" ||
        state.sync.snapshotReceived ||
        (state.sessionState !== null && message.bootstrap.state.id !== state.sessionState.id) ||
        message.bootstrap.viewRevision > state.sync.targetRevision
      ) {
        return protocolError(state);
      }
      return replaceFromBootstrap(state, message.bootstrap);

    case "session_delta": {
      const isLiveV2Delta = state.protocol === "v2" && state.ready && !state.sync;
      if (
        (!state.sync && !isLiveV2Delta) ||
        (state.sync?.mode === "snapshot" && !state.sync.snapshotReceived)
      ) {
        return protocolError(state);
      }
      const currentRevision = state.lastAppliedRevision;
      if (currentRevision === null) return protocolError(state);
      if (message.revision <= currentRevision) return state;
      if (
        message.revision !== currentRevision + 1 ||
        (state.sync !== null && message.revision > state.sync.targetRevision)
      ) {
        return protocolError(state);
      }
      return {
        ...applyDelta(state, message.delta),
        lastAppliedRevision: message.revision,
      };
    }

    case "session_ready":
      if (
        !state.sync ||
        message.sessionId !== state.sessionState?.id ||
        message.appliedRevision !== state.sync.targetRevision ||
        message.appliedRevision !== state.lastAppliedRevision ||
        (state.sync.mode === "snapshot" && !state.sync.snapshotReceived)
      ) {
        return protocolError(state);
      }
      return {
        ...state,
        ready: true,
        replaying: false,
        sync: null,
        currentParticipantId: message.participantId || state.currentParticipantId,
      };

    case "session_history_page": {
      let viewEvents = state.viewEvents;
      for (const item of message.items) viewEvents = upsertViewEvent(viewEvents, item);
      return {
        ...withViewEvents(state, viewEvents),
        hasMoreHistory: message.hasMore,
        cursor: message.cursor,
        loadingHistory: false,
      };
    }

    case "history_page":
      // Prepend older events to the beginning.
      return {
        ...state,
        events: [...message.items.map(toUiSandboxEvent), ...state.events],
        hasMoreHistory: message.hasMore ?? false,
        cursor: message.cursor ?? null,
        loadingHistory: false,
      };

    case "presence_sync":
    case "presence_update":
      return { ...state, participants: message.participants };

    case "presence_leave":
      return {
        ...state,
        participants: state.participants.filter((p) => p.userId !== message.userId),
      };

    case "sandbox_warming":
      return updateSessionState(state, (prev) => ({ ...prev, sandboxStatus: "warming" }));

    case "sandbox_spawning":
      return updateSessionState(state, (prev) => ({
        ...prev,
        sandboxStatus: "spawning",
        ...CLEARED_SANDBOX_ACCESS_STATE,
      }));

    case "sandbox_status": {
      const isReplacementStart = message.status === "spawning";
      const shouldClearAccessState =
        isReplacementStart ||
        message.status === "stale" ||
        message.status === "stopped" ||
        message.status === "failed";
      return updateSessionState(state, (prev) => ({
        ...prev,
        sandboxStatus: message.status,
        ...(shouldClearAccessState && CLEARED_SANDBOX_ACCESS_STATE),
        ...(isReplacementStart && { sandboxDashboardUrl: undefined }),
      }));
    }

    case "sandbox_ready":
      return updateSessionState(state, (prev) => ({ ...prev, sandboxStatus: "ready" }));

    case "sandbox_error":
      return updateSessionState(state, (prev) => ({
        ...prev,
        sandboxStatus: "failed",
        ...CLEARED_SANDBOX_ACCESS_STATE,
      }));

    case "code_server_info":
      return updateSessionState(state, (prev) => ({
        ...prev,
        codeServerUrl: message.url,
        codeServerPassword: message.password,
      }));

    case "ttyd_info":
      return updateSessionState(state, (prev) => ({
        ...prev,
        ttydUrl: message.url,
        ttydToken: message.token,
      }));

    case "tunnel_urls":
      return updateSessionState(state, (prev) => ({ ...prev, tunnelUrls: message.urls }));

    case "sandbox_dashboard_url":
      return updateSessionState(state, (prev) => ({ ...prev, sandboxDashboardUrl: message.url }));

    case "artifact_created":
    case "artifact_updated":
      // Upsert-by-id: a create appends, an update replaces in place so the
      // artifact list order stays stable.
      return {
        ...state,
        artifacts: upsertArtifact(state.artifacts, toUiArtifact(message.artifact)),
      };

    case "session_branch":
      // Branch updates apply only to the active session detail view.
      return updateSessionState(state, (prev) =>
        applySessionBranchUpdate(prev, message.branchName, message.repoOwner, message.repoName)
      );

    case "session_title":
      if (!message.title) return state;
      return updateSessionState(state, (prev) => ({ ...prev, title: message.title }));

    case "session_status":
      return updateSessionState(state, (prev) => ({ ...prev, status: message.status }));

    case "processing_status":
      return updateSessionState(state, (prev) => ({
        ...prev,
        isProcessing: message.isProcessing,
      }));

    case "error":
      // Reset loading state if a fetch_history request was rejected.
      return { ...state, loadingHistory: false };

    // pong, prompt_queued, child_session_update, snapshot_saved,
    // sandbox_restored, sandbox_warning: no view-state change.
    default:
      return state;
  }
}

export function sessionSocketReducer(
  state: SessionSocketState,
  action: SessionSocketAction
): SessionSocketState {
  switch (action.type) {
    case "server_message":
      return reduceServerMessage(state, action.message);

    case "events_appended": {
      let next: SessionSocketState = { ...state, events: [...state.events, ...action.events] };
      for (const event of action.events) {
        if (
          state.protocol !== "v2" &&
          event.type === "step_finish" &&
          typeof event.cost === "number" &&
          Number.isFinite(event.cost) &&
          event.cost > 0
        ) {
          const stepCost = event.cost;
          next = updateSessionState(next, (prev) => ({
            ...prev,
            totalCost: (prev.totalCost ?? 0) + stepCost,
          }));
        }
      }
      return next;
    }

    case "history_requested":
      return { ...state, loadingHistory: true };

    case "prompt_sent":
      // Optimistic: the server confirms with a processing_status message.
      return updateSessionState(state, (prev) => ({ ...prev, isProcessing: true }));

    case "socket_closed":
      return {
        ...state,
        ready: false,
        replaying: false,
        sync: null,
        participants: [],
      };

    case "access_loaded":
      return updateSessionState(state, (previous) => ({
        ...previous,
        ...CLEARED_SANDBOX_ACCESS_STATE,
        ...(action.access ?? {}),
      }));

    case "protocol_error":
      return protocolError(state);
  }
}

function isLegacyCanonicalMessage(
  message: Exclude<ServerMessage, { type: "sandbox_event" }>
): boolean {
  return (
    message.type === "artifact_created" ||
    message.type === "artifact_updated" ||
    message.type === "sandbox_status" ||
    message.type === "sandbox_ready" ||
    message.type === "session_status" ||
    message.type === "session_title" ||
    message.type === "session_branch" ||
    message.type === "processing_status" ||
    message.type === "code_server_info" ||
    message.type === "ttyd_info" ||
    message.type === "tunnel_urls" ||
    message.type === "sandbox_dashboard_url"
  );
}
