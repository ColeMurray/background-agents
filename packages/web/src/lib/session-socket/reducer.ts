import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, ServerMessage, SessionState } from "@open-inspect/shared";
import { toUiArtifact } from "./artifact-metadata";
import { collapseReplayTokenEvents, toUiSandboxEvent } from "./event-log";

export interface HistoryCursor {
  timestamp: number;
  id: string;
}

/**
 * Pure projection of the session view built from server messages. The
 * WebSocket transport, token buffering, and SWR cache effects live outside —
 * this reducer only turns already-normalized inputs into the next view state.
 */
export interface SessionSocketState {
  replaying: boolean;
  sessionState: SessionState | null;
  events: SandboxEvent[];
  participants: ParticipantPresence[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  cursor: HistoryCursor | null;
}

export const initialSessionSocketState: SessionSocketState = {
  replaying: true,
  sessionState: null,
  events: [],
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
  /** The socket closed (clean or not). */
  | { type: "socket_closed" };

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
  switch (message.type) {
    case "subscribed":
      // Replace local artifacts and events with the subscribed snapshot so
      // reconnects still clear stale state instead of merging stale client
      // data.
      return {
        ...state,
        replaying: false,
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
        hasMoreHistory: message.replay?.hasMore ?? false,
        cursor: message.replay?.cursor ?? null,
        // A fetch_history dropped by a disconnect would otherwise leave this
        // stuck true and block loadOlderEvents after the reconnect.
        loadingHistory: false,
      };

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
      return { ...state, replaying: false };
  }
}
