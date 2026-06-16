import type { EmailCallbackContext } from "@open-inspect/shared";

export interface Env {
  EMAIL_KV: KVNamespace;
  CONTROL_PLANE: Fetcher;

  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  DEFAULT_REASONING_EFFORT?: string;
  APP_NAME?: string;
  LOG_LEVEL?: string;

  AGENTMAIL_API_KEY: string;
  AGENTMAIL_WEBHOOK_SECRET: string;
  AGENTMAIL_API_BASE_URL?: string;
  EMAIL_ROUTES_JSON?: string;
  INTERNAL_CALLBACK_SECRET?: string;
}

export interface AgentMailWebhookPayload {
  type?: string;
  event_type?: string;
  eventType?: string;
  event_id?: string;
  eventId?: string;
  message?: Record<string, unknown>;
  thread?: Record<string, unknown>;
}

export interface NormalizedEmailMessage {
  inboxId: string;
  threadId: string;
  messageId: string;
  from: string;
  senderEmail: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  extractedText?: string;
  attachments: unknown[];
  labels: string[];
  size?: number;
}

export interface EmailRoute {
  id: string;
  clientId: string;
  repoOwner: string;
  repoName: string;
  branch?: string;
  workflow?: string;
  skill?: string;
  model?: string;
  reasoningEffort?: string;
  inboxIds?: string[];
  recipientAddresses?: string[];
  allowedSenders?: string[];
  allowedDomains?: string[];
}

export interface EmailRoutesConfig {
  routes: EmailRoute[];
}

export interface EmailThreadSession {
  sessionId: string;
  routeId: string;
  requestId: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  timestamp: number;
  signature: string;
  context: EmailCallbackContext;
}

export interface ToolCallCallback {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  timestamp: number;
  signature: string;
  context: EmailCallbackContext;
}
