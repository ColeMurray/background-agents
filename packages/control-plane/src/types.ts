/**
 * Type definitions for Open-Inspect Control Plane.
 */

import type {
  ArtifactType,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  SessionStatus,
} from "@open-inspect/shared";
import { z } from "zod";

export type {
  ArtifactType,
  Attachment,
  ClientMessage,
  CreateSessionRequest,
  CreateSessionResponse,
  EventResponse,
  EventType,
  GitSyncStatus,
  ListEventsResponse,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  ParticipantPresence,
  SpawnSource,
  SandboxEvent,
  SandboxStatus,
  ServerMessage,
  SessionRepositoryState,
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

  // Durable Objects
  SCHEDULER?: DurableObjectNamespace; // SchedulerDO for automation engine

  // D1 database
  DB: D1Database;

  // R2 buckets
  MEDIA_BUCKET: R2Bucket;

  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
  REPO_SECRETS_ENCRYPTION_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_SECRET?: string; // Shared secret for authenticating with Modal endpoints
  ANTHROPIC_API_KEY?: string; // Anthropic API key for Claude models
  DAYTONA_API_KEY?: string; // Daytona REST API key (Bearer auth + HMAC derivation)
  OPENCOMPUTER_API_KEY?: string; // OpenComputer REST API key (X-API-Key auth + HMAC derivation)
  VERCEL_TOKEN?: string; // Vercel API access token for Sandbox API
  INTERNAL_CALLBACK_SECRET?: string; // For signing callbacks to slack-bot
  SLACK_BOT_TOKEN?: string; // Slack bot token for agent-initiated chat.postMessage calls

  // GitHub App secrets (for git operations)
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;

  // GitLab secrets (for git operations and API access when SCM_PROVIDER=gitlab)
  GITLAB_ACCESS_TOKEN?: string;
  GITLAB_NAMESPACE?: string; // Group namespace to scope repository listing

  // Variables
  DEPLOYMENT_NAME: string;
  APP_NAME?: string; // Display name for user-visible UI, PR footers, and HTTP User-Agent headers
  SCM_PROVIDER?: string; // Source control provider for this deployment (default: github)
  WORKER_URL?: string; // Base URL for the worker (for callbacks)
  WEB_APP_URL?: string; // Base URL for the web app (for PR links)
  CF_ACCOUNT_ID?: string; // Cloudflare account ID
  SANDBOX_PROVIDER?: string; // "modal" (default), "daytona", "vercel", or "opencomputer"
  MODAL_WORKSPACE?: string; // Modal workspace name
  MODAL_ENVIRONMENT?: string; // Modal environment name for dashboard URLs
  MODAL_ENVIRONMENT_WEB_SUFFIX?: string; // Modal environment web suffix for endpoint URLs
  DAYTONA_API_URL?: string; // Daytona REST API base URL
  DAYTONA_BASE_SNAPSHOT?: string; // Named Daytona snapshot used for fresh sandbox creation
  DAYTONA_AUTO_STOP_INTERVAL_MINUTES?: string; // Daytona idle stop interval in minutes
  DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES?: string; // Daytona archive interval in minutes
  DAYTONA_TARGET?: string; // Optional Daytona target name
  OPENCOMPUTER_API_URL?: string; // OpenComputer REST API base URL
  OPENCOMPUTER_TEMPLATE?: string; // Declarative template containing sandbox runtime
  VERCEL_PROJECT_ID?: string; // Vercel project ID used for Sandbox API scope
  VERCEL_TEAM_ID?: string; // Optional Vercel team ID used for Sandbox API scope
  VERCEL_BASE_SNAPSHOT_ID?: string; // Optional prebuilt base snapshot with sandbox runtime
  VERCEL_BASE_SNAPSHOT_NAME?: string; // Optional managed base snapshot sandbox name
  VERCEL_RUNTIME?: string; // Vercel sandbox runtime (default: node24)
  VERCEL_SANDBOX_API_BASE_URL?: string; // Override for tests or non-default Vercel API base URL
  VERCEL_SNAPSHOT_EXPIRATION_MS?: string; // Snapshot expiration in ms; 0 means no expiration

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

export const githubTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export type GitHubTokenResponse = z.infer<typeof githubTokenResponseSchema>;
