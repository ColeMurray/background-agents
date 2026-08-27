import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  ParticipantPresence,
  PromptQueueItem,
  ServerMessage,
  SessionSnapshot,
  SessionState,
  SessionTimelineEvent,
} from "@open-inspect/shared/types/server-messages";
import { toUiArtifact } from "./artifact-metadata";
import { collapseReplayTokenEvents, toUiSandboxEvent } from "./event-log";

interface HistoryCursor {
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
  ready: boolean;
  presenceSynced: boolean;
  sessionState: SessionState | null;
  events: SandboxEvent[];
  participants: ParticipantPresence[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  cursor: HistoryCursor | null;
  promptQueue: PromptQueueItem[];
  /**
   * Why the sandbox last failed, as reported by the control plane — the
   * provider's own message (quota, rate limit, bad config), not a status label.
   * Set from `sandbox_error` and from the spawn error carried by the snapshot /
   * `subscribed`, and cleared as soon as a fresh attempt starts or succeeds, so
   * it never outlives the failure it explains.
   */
  sandboxError: string | null;
}

export const initialSessionSocketState: SessionSocketState = {
  ready: false,
  presenceSynced: false,
  sessionState: null,
  events: [],
  participants: [],
  artifacts: [],
  currentParticipantId: null,
  hasMoreHistory: false,
  loadingHistory: false,
  cursor: null,
  promptQueue: [],
  sandboxError: null,
};

export type SessionSocketAction =
  /** Any server message except sandbox_event, which is normalized first. */
  | { type: "server_message"; message: Exclude<ServerMessage, { type: "sandbox_event" }> }
  /** Live sandbox events, already passed through token buffering. */
  | { type: "events_appended"; events: SandboxEvent[] }
  /** A fetch_history request was sent. */
  | { type: "history_requested" }
  /** The socket closed (clean or not). */
  | { type: "socket_closed" };

const CLEARED_SANDBOX_RUNTIME_STATE = {
  codeServerUrl: undefined,
  vncUrl: undefined,
  tunnelUrls: undefined,
  ttydUrl: undefined,
} satisfies Partial<SessionState>;

/** Replace an artifact in place by id, or prepend when it is new. */
function upsertArtifact(artifacts: Artifact[], nextArtifact: Artifact): Artifact[] {
  const existingIndex = artifacts.findIndex((artifact) => artifact.id === nextArtifact.id);
  if (existingIndex === -1) {
    return [nextArtifact, ...artifacts];
  }
  return artifacts.map((artifact, index) => (index === existingIndex ? nextArtifact : artifact));
}

function renderTimelineEvents(items: SessionTimelineEvent[]): SandboxEvent[] {
  return collapseReplayTokenEvents(items.map((item) => toUiSandboxEvent(item.event)));
}

export function createSessionSocketState(snapshot: SessionSnapshot): SessionSocketState {
  const timelineEvents = snapshot.timeline.events;
  return {
    ...initialSessionSocketState,
    sessionState: {
      ...snapshot.session,
      isProcessing: snapshot.session.isProcessing ?? false,
      totalCost: snapshot.session.totalCost ?? 0,
    },
    artifacts: snapshot.artifacts.map(toUiArtifact),
    events: renderTimelineEvents(timelineEvents),
    hasMoreHistory: snapshot.timeline.hasMore,
    cursor: snapshot.timeline.cursor,
    promptQueue: snapshot.promptQueue,
    sandboxError: snapshot.spawnError ?? null,
  };
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
    case "subscribed": {
      const timelineEvents = message.timeline.events;
      // Replace local artifacts and events with the subscribed snapshot so
      // reconnects still clear stale state instead of merging stale client
      // data.
      return {
        ...state,
        ready: true,
        sessionState: {
          ...message.session,
          // Normalize optional snapshot fields for the view.
          isProcessing: message.session.isProcessing ?? false,
          totalCost: message.session.totalCost ?? 0,
        },
        artifacts: message.artifacts.map(toUiArtifact),
        currentParticipantId: message.participantId || state.currentParticipantId,
        events: renderTimelineEvents(timelineEvents),
        hasMoreHistory: message.timeline.hasMore,
        cursor: message.timeline.cursor,
        // A fetch_history dropped by a disconnect would otherwise leave this
        // stuck true and block loadOlderEvents after the reconnect.
        loadingHistory: false,
        promptQueue: message.promptQueue,
        sandboxError: message.spawnError ?? null,
      };
    }

    case "history_page": {
      return {
        ...state,
        events: [...message.items.map((item) => toUiSandboxEvent(item.event)), ...state.events],
        hasMoreHistory: message.hasMore,
        cursor: message.cursor,
        loadingHistory: false,
      };
    }

    case "presence_sync":
      return { ...state, presenceSynced: true, participants: message.participants };

    case "presence_update":
      return { ...state, participants: message.participants };

    case "presence_leave":
      return {
        ...state,
        participants: state.participants.filter((p) => p.userId !== message.userId),
      };

    case "sandbox_warming":
      return updateSessionState({ ...state, sandboxError: null }, (prev) => ({
        ...prev,
        sandboxStatus: "warming",
      }));

    case "sandbox_spawning":
      // A new attempt supersedes whatever the last one failed with.
      return updateSessionState({ ...state, sandboxError: null }, (prev) => ({
        ...prev,
        sandboxStatus: "spawning",
        ...CLEARED_SANDBOX_RUNTIME_STATE,
      }));

    case "sandbox_status": {
      const isReplacementStart = message.status === "spawning";
      const shouldClearAccessState =
        isReplacementStart ||
        message.status === "stale" ||
        message.status === "stopped" ||
        message.status === "failed";
      return updateSessionState(
        message.status === "failed" ? state : { ...state, sandboxError: null },
        (prev) => ({
          ...prev,
          sandboxStatus: message.status,
          ...(shouldClearAccessState && CLEARED_SANDBOX_RUNTIME_STATE),
          ...(isReplacementStart && { sandboxDashboardUrl: undefined }),
        })
      );
    }

    case "sandbox_ready":
      return updateSessionState({ ...state, sandboxError: null }, (prev) => ({
        ...prev,
        sandboxStatus: "ready",
      }));

    case "sandbox_error":
      return updateSessionState({ ...state, sandboxError: message.error }, (prev) => ({
        ...prev,
        sandboxStatus: "failed",
        ...CLEARED_SANDBOX_RUNTIME_STATE,
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

    case "prompt_queue_updated":
      return { ...state, promptQueue: message.promptQueue };

    case "error":
      // Reset loading state if a fetch_history request was rejected.
      return { ...state, loadingHistory: false };

    // pong, prompt_queued, prompt_cancelled, child_session_update, snapshot_saved,
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

    case "socket_closed":
      return {
        ...state,
        ready: false,
        presenceSynced: false,
        participants: [],
      };
  }
}
