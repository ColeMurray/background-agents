import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import type { GitSyncStatus, SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type {
  MessageSource,
  MessageStatus,
  SandboxStatus,
  SessionStatus,
  SpawnSource,
} from "@open-inspect/shared/types/sessions";

type UserMessageEvent = Extract<SandboxEvent, { type: "user_message" }>;
type MutableTimelineEvent = Extract<
  SandboxEvent,
  { type: "token" | "tool_call" | "execution_complete" }
>;
type LifecycleTimelineEvent = Extract<
  SandboxEvent,
  { type: "token" | "tool_call" | "execution_complete" | "context_compacted" | "user_message" }
>;
type ImmutableTimelineEvent = Exclude<SandboxEvent, LifecycleTimelineEvent>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type ContextCompactedEvent = Extract<SandboxEvent, { type: "context_compacted" }>;

export interface SessionStoreRepository {
  position: number;
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string | null;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
}

/** Provider-neutral state for one session aggregate. */
export interface SessionRecord {
  id: string;
  sessionName: string | null;
  title: string | null;
  repositories: SessionStoreRepository[];
  model: string;
  reasoningEffort: string | null;
  status: SessionStatus;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  spawnDepth: number;
  codeServerEnabled: boolean;
  vncEnabled: boolean;
  totalCost: number;
  sandboxSettings: SandboxSettings | null;
  environmentId: string | null;
  agentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EventWrite<TEvent extends SandboxEvent> {
  event: TEvent;
  createdAt: number;
}

/** Adds an immutable event at the end of the timeline. */
export interface AppendEvent extends EventWrite<ImmutableTimelineEvent> {
  operation: "append";
  id: string;
}

/**
 * Replaces the mutable event identified by its canonical event identity.
 * Existing timeline sequence is retained. Token and completion writes update
 * createdAt; tool-call writes retain the original createdAt.
 */
export interface UpsertEvent<
  TEvent extends MutableTimelineEvent = MutableTimelineEvent,
> extends EventWrite<TEvent> {
  operation: "upsert";
}

/**
 * Seals the prompt's current token event and appends a compaction marker atomically.
 * The current and sealed token identities are derived from event.messageId and id.
 */
export interface CompactEvent extends EventWrite<ContextCompactedEvent> {
  operation: "compact";
  id: string;
}

export type PendingEvent = AppendEvent | UpsertEvent | CompactEvent;

/** Stored timeline state; write instructions deliberately do not cross this boundary. */
export interface PersistedEvent {
  id: string;
  event: SandboxEvent;
  promptId: string | null;
  createdAt: number;
  sequence: number;
}

export interface PromptRecord {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  model: string | null;
  reasoningEffort: string | null;
  attachments: ResolvedSessionAttachment[] | null;
  callbackContext: CallbackContext | null;
  clientRequestId: string | null;
  requestFingerprint: string | null;
  status: MessageStatus;
  errorMessage: string | null;
  stopConfirmationDeadline: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Atomically validates queue admission, claims attachments, and creates a prompt. */
export interface CreatePromptInput {
  prompt: Omit<
    PromptRecord,
    | "attachments"
    | "status"
    | "errorMessage"
    | "stopConfirmationDeadline"
    | "startedAt"
    | "completedAt"
  >;
  attachments: ResolvedSessionAttachment[];
  maxUnfinishedPrompts: number;
}

export type CreatePromptResult =
  | { outcome: "created"; prompt: PromptRecord; position: number }
  | { outcome: "duplicate"; prompt: PromptRecord; position: number | null }
  | { outcome: "request-conflict" }
  | { outcome: "attachment-conflict" }
  | { outcome: "queue-full" }
  | { outcome: "session-not-promptable" };

/**
 * A short-lived reservation of the next pending prompt. Reserving does not mark
 * the prompt as processing; callers start it only after sandbox delivery succeeds.
 */
export interface PromptClaim {
  claimId: string;
  prompt: PromptRecord & { status: "pending" };
  claimedAt: number;
  expiresAt: number;
}

/**
 * Atomic prompt lifecycle commands. Implementations reject stale claims and
 * failed expected-status checks rather than silently applying partial updates.
 */
export type PromptUpdate =
  | {
      type: "start";
      claimId: string;
      startedAt: number;
      event: EventWrite<UserMessageEvent> & { operation: "append"; id: string };
    }
  | {
      type: "complete";
      expectedStatus: "pending" | "processing";
      event: UpsertEvent<ExecutionCompleteEvent>;
    }
  | { type: "requeue"; promptId: string; claimId: string }
  | { type: "cancel"; promptId: string }
  | { type: "await-stop-confirmation"; promptId: string; deadline: number }
  | { type: "clear-stop-confirmation"; promptId: string };

/** Provider-neutral persisted sandbox state. Credentials may be encrypted at rest. */
export interface SandboxRecord {
  id: string;
  connectionId: string | null;
  providerHandle: string | null;
  snapshotImageRef: string | null;
  authTokenHash: string | null;
  status: SandboxStatus;
  gitSyncStatus: GitSyncStatus;
  lastHeartbeatAt: number | null;
  lastActivityAt: number | null;
  lastSpawnError: string | null;
  lastSpawnErrorAt: number | null;
  codeServerUrl: string | null;
  codeServerCredential: string | null;
  vncUrl: string | null;
  vncCredential: string | null;
  tunnelUrls: Record<string, string> | null;
  terminalUrl: string | null;
  terminalCredential: string | null;
  spawnFailureCount: number;
  lastSpawnFailureAt: number | null;
  createdAt: number;
}

export type SandboxUpdate =
  | {
      type: "initialize";
      sandboxId: string;
      status: SandboxStatus;
      gitSyncStatus: GitSyncStatus;
      createdAt: number;
    }
  | {
      type: "prepare-for-spawn";
      connectionId: string;
      authTokenHash: string;
      status: SandboxStatus;
      createdAt: number;
    }
  | { type: "resume"; status: SandboxStatus; createdAt: number }
  | { type: "set-status"; status: SandboxStatus }
  | { type: "set-provider-handle"; providerHandle: string }
  | { type: "set-snapshot-image"; sandboxId: string; snapshotImageRef: string }
  | { type: "record-heartbeat"; heartbeatAt: number }
  | { type: "record-activity"; activityAt: number }
  | { type: "set-git-sync-status"; status: GitSyncStatus }
  | { type: "set-spawn-error"; error: string | null; errorAt: number | null }
  | { type: "set-code-server-access"; url?: string | null; credential?: string | null }
  | { type: "set-vnc-access"; url?: string | null; credential?: string | null }
  | { type: "set-tunnel-urls"; tunnelUrls: Record<string, string> | null }
  | { type: "set-terminal-access"; url?: string | null; credential?: string | null }
  | { type: "reset-circuit-breaker" }
  | { type: "record-spawn-failure"; failedAt: number };

export interface HistoryCursor {
  createdAt: number;
  eventId: string;
  /** Absent only while reading a cursor created before timeline sequencing was introduced. */
  sequence?: number;
}

interface EventTypeHistoryFilter {
  mode: "include" | "exclude";
  eventTypes: SandboxEvent["type"][];
}

export type HistoryFilter =
  | ({ type: "event-types" } & EventTypeHistoryFilter)
  | { type: "for-prompt"; promptId: string; eventTypes?: EventTypeHistoryFilter }
  | { type: "without-prompt"; eventTypes?: EventTypeHistoryFilter };

export interface HistoryQuery {
  cursor?: HistoryCursor | null;
  limit: number;
  filter?: HistoryFilter;
}

/** Events are ordered oldest-to-newest within each backward-paginated page. */
export type SessionHistory =
  | { events: PersistedEvent[]; hasMore: true; cursor: HistoryCursor }
  | { events: PersistedEvent[]; hasMore: false; cursor: HistoryCursor | null };

/**
 * Atomic persistence operations for one initialized session.
 *
 * Implementations may use embedded or remote storage, but callers only depend
 * on asynchronous domain operations and normalized records.
 */
export interface SessionStore {
  getSession(): Promise<SessionRecord>;
  appendEvents(events: PendingEvent[]): Promise<PersistedEvent[]>;
  createPrompt(input: CreatePromptInput): Promise<CreatePromptResult>;
  claimNextPrompt(): Promise<PromptClaim | null>;
  updatePrompt(input: PromptUpdate): Promise<void>;
  getSandbox(): Promise<SandboxRecord | null>;
  updateSandbox(input: SandboxUpdate): Promise<void>;
  getHistory(input: HistoryQuery): Promise<SessionHistory>;
}
