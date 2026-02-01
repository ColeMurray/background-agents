/**
 * Repository interfaces for database operations.
 *
 * These interfaces define the contract for data access operations,
 * allowing for easy testing and potential future database migrations.
 */

import type {
  SessionRow,
  ParticipantRow,
  MessageRow,
  EventRow,
  ArtifactRow,
  SandboxRow,
  SessionUpdate,
  SandboxUpdate,
} from "../types";
import type { MessageStatus } from "../../types";

/**
 * Options for listing messages with pagination.
 */
export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
  status?: MessageStatus;
}

/**
 * Result of listing messages with pagination info.
 */
export interface ListMessagesResult {
  messages: MessageRow[];
  hasMore: boolean;
}

/**
 * Data required to create a new message.
 */
export interface CreateMessageData {
  id: string;
  authorId: string;
  content: string;
  source: string;
  model?: string | null;
  attachments?: string | null;
  callbackContext?: string | null;
  createdAt: number;
}

/**
 * Repository for message database operations.
 */
export interface MessageRepository {
  /**
   * Get a message by ID.
   */
  getById(id: string): MessageRow | null;

  /**
   * Get the currently processing message (if any).
   */
  getProcessing(): MessageRow | null;

  /**
   * Get the next pending message to process.
   */
  getNextPending(): MessageRow | null;

  /**
   * Create a new message.
   */
  create(data: CreateMessageData): MessageRow;

  /**
   * Update message status with optional timing fields.
   */
  updateStatus(
    id: string,
    status: MessageStatus,
    extras?: { startedAt?: number; completedAt?: number; errorMessage?: string }
  ): void;

  /**
   * List messages with optional filtering and pagination.
   */
  list(options: ListMessagesOptions): ListMessagesResult;

  /**
   * Get total message count.
   */
  count(): number;
}

/**
 * Repository for session database operations.
 */
export interface SessionRepository {
  /**
   * Get the session record.
   * Since each Durable Object has one session, this returns the single row.
   */
  get(): SessionRow | null;

  /**
   * Create the initial session record.
   */
  create(data: Omit<SessionRow, "created_at" | "updated_at">): SessionRow;

  /**
   * Update session fields.
   */
  update(updates: SessionUpdate): void;

  /**
   * Update session status.
   */
  updateStatus(status: string): void;

  /**
   * Update current SHA.
   */
  updateCurrentSha(sha: string): void;
}

/**
 * Data required to create a new participant.
 */
export interface CreateParticipantData {
  id: string;
  userId: string;
  githubUserId?: string | null;
  githubLogin?: string | null;
  githubEmail?: string | null;
  githubName?: string | null;
  role: string;
  githubAccessTokenEncrypted?: string | null;
  githubRefreshTokenEncrypted?: string | null;
  githubTokenExpiresAt?: number | null;
  wsAuthToken?: string | null;
  wsTokenCreatedAt?: number | null;
  joinedAt: number;
}

/**
 * Repository for participant database operations.
 */
export interface ParticipantRepository {
  /**
   * Get a participant by ID.
   */
  getById(id: string): ParticipantRow | null;

  /**
   * Get a participant by user ID.
   */
  getByUserId(userId: string): ParticipantRow | null;

  /**
   * Get a participant by WebSocket auth token hash.
   */
  getByWsAuthToken(tokenHash: string): ParticipantRow | null;

  /**
   * Create a new participant.
   */
  create(data: CreateParticipantData): ParticipantRow;

  /**
   * Update participant tokens.
   */
  updateTokens(
    id: string,
    data: {
      githubAccessTokenEncrypted?: string;
      githubRefreshTokenEncrypted?: string;
      githubTokenExpiresAt?: number;
    }
  ): void;

  /**
   * Update participant WebSocket auth token.
   */
  updateWsAuthToken(id: string, tokenHash: string | null, createdAt: number | null): void;

  /**
   * List all participants.
   */
  list(): ParticipantRow[];
}

/**
 * Options for listing events with pagination and filtering.
 */
export interface ListEventsOptions {
  limit?: number;
  messageId?: string;
  types?: string[];
}

/**
 * Data required to create a new event.
 */
export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId?: string | null;
  createdAt: number;
}

/**
 * Repository for event database operations.
 */
export interface EventRepository {
  /**
   * Get an event by ID.
   */
  getById(id: string): EventRow | null;

  /**
   * Create a new event.
   */
  create(data: CreateEventData): EventRow;

  /**
   * List events with optional filtering and pagination.
   */
  list(options: ListEventsOptions): EventRow[];
}

/**
 * Data required to create a new artifact.
 */
export interface CreateArtifactData {
  id: string;
  type: string;
  url?: string | null;
  metadata?: string | null;
  createdAt: number;
}

/**
 * Repository for artifact database operations.
 */
export interface ArtifactRepository {
  /**
   * Get an artifact by ID.
   */
  getById(id: string): ArtifactRow | null;

  /**
   * Create a new artifact.
   */
  create(data: CreateArtifactData): ArtifactRow;

  /**
   * List all artifacts ordered by creation time (newest first).
   */
  list(): ArtifactRow[];
}

/**
 * Repository for sandbox database operations.
 */
export interface SandboxRepository {
  /**
   * Get the sandbox record.
   * Since each Durable Object has one sandbox, this returns the single row.
   */
  get(): SandboxRow | null;

  /**
   * Create the initial sandbox record.
   */
  create(data: Omit<SandboxRow, "createdAt">): SandboxRow;

  /**
   * Update sandbox fields.
   */
  update(updates: SandboxUpdate): void;

  /**
   * Update sandbox status.
   */
  updateStatus(status: string): void;

  /**
   * Update sandbox git sync status.
   */
  updateGitSyncStatus(status: string): void;

  /**
   * Update last heartbeat timestamp.
   */
  updateLastHeartbeat(timestamp: number): void;

  /**
   * Update last activity timestamp.
   */
  updateLastActivity(timestamp: number): void;

  /**
   * Update preview tunnel URL.
   */
  updatePreviewTunnelUrl(url: string | null): void;

  /**
   * Update all tunnel URLs (JSON string).
   */
  updateTunnelUrls(tunnelUrls: string | null): void;

  /**
   * Update snapshot ID and optional image ID.
   */
  updateSnapshot(snapshotId: string, snapshotImageId?: string | null): void;

  /**
   * Increment spawn failure count and update last failure timestamp.
   */
  incrementSpawnFailureCount(timestamp: number): void;

  /**
   * Reset spawn failure count (after successful spawn).
   */
  resetSpawnFailureCount(): void;

  /**
   * Get spawn failure count and last failure timestamp.
   */
  getSpawnFailureInfo(): { count: number; lastFailure: number | null };
}
