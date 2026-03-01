/**
 * Type definitions for Open-Inspect Control Plane.
 */

import type {
  ArtifactType,
  EventType,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  SessionStatus,
} from "@open-inspect/shared";

export type {
  ArtifactType,
  Attachment,
  ClientMessage,
  CreateSessionRequest,
  CreateSessionResponse,
  EventType,
  GitSyncStatus,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  ParticipantPresence,
  SpawnSource,
  SandboxEvent,
  SandboxStatus,
  ServerMessage,
  SessionState,
  SessionStatus,
} from "@open-inspect/shared";

// Environment bindings
export interface Env {
  // Durable Objects
  SESSION: DurableObjectNamespace;

  // KV Namespaces
  REPOS_CACHE: KVNamespace; // Short-lived cache for /repos listing

  // Service bindings
  SLACK_BOT?: Fetcher; // Optional - only if slack-bot is deployed
  LINEAR_BOT?: Fetcher; // Optional - only if linear-bot is deployed

  // D1 database
  DB: D1Database;

  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
  REPO_SECRETS_ENCRYPTION_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_SECRET?: string; // Shared secret for authenticating with Modal endpoints
  INTERNAL_CALLBACK_SECRET?: string; // For signing callbacks to slack-bot

  // GitHub App secrets (for git operations)
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;

  // Variables
  DEPLOYMENT_NAME: string;
  SCM_PROVIDER?: string; // Source control provider for this deployment (default: github)
  WORKER_URL?: string; // Base URL for the worker (for callbacks)
  WEB_APP_URL?: string; // Base URL for the web app (for PR links)
  CF_ACCOUNT_ID?: string; // Cloudflare account ID
  MODAL_WORKSPACE?: string; // Modal workspace name (used in Modal endpoint URLs)

  // Sandbox lifecycle configuration
  SANDBOX_INACTIVITY_TIMEOUT_MS?: string; // Inactivity timeout in ms (default: 600000 = 10 min)
  EXECUTION_TIMEOUT_MS?: string; // Max processing time before auto-fail (default: 5400000 = 90 min)

  // Logging
  LOG_LEVEL?: string; // "debug" | "info" | "warn" | "error" (default: "info")
}

// Client info (stored in DO memory)
export interface ClientInfo {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
  clientId: string;
  ws: WebSocket;
  lastFetchHistoryAt?: number;
}

export interface SessionResponse {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ListSessionsResponse {
  sessions: SessionResponse[];
  total: number;
  hasMore: boolean;
}

export interface MessageResponse {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface EventResponse {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventsResponse {
  events: EventResponse[];
  cursor?: string;
  hasMore: boolean;
}

export interface ArtifactResponse {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ParticipantResponse {
  id: string;
  userId: string;
  scmLogin: string | null;
  scmName: string | null;
  role: ParticipantRole;
  joinedAt: number;
}

// GitHub OAuth types
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
}
