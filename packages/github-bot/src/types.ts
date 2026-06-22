/**
 * Environment bindings for the GitHub Bot Cloudflare Worker.
 */
export interface Env {
  /** KV namespace for deduplicating webhook deliveries. */
  GITHUB_KV: KVNamespace;

  /** Service binding to the control plane worker. */
  CONTROL_PLANE: Fetcher;

  /** Deployment name for logging/identification. */
  DEPLOYMENT_NAME: string;

  /** Display name shown in user-visible bot messages and HTTP User-Agent headers. */
  APP_NAME?: string;

  /** Default model ID for new sessions. */
  DEFAULT_MODEL: string;

  /** GitHub App bot username (e.g., "open-inspect-bot[bot]"). */
  GITHUB_BOT_USERNAME: string;

  /** GitHub App ID for JWT generation. */
  GITHUB_APP_ID: string;

  /** GitHub App private key (PKCS#8 PEM) for JWT signing. */
  GITHUB_APP_PRIVATE_KEY: string;

  /** GitHub App installation ID for token exchange. */
  GITHUB_APP_INSTALLATION_ID: string;

  /** Webhook secret for verifying GitHub webhook signatures. */
  GITHUB_WEBHOOK_SECRET: string;

  /** Shared secret for HMAC auth to the control plane. */
  INTERNAL_CALLBACK_SECRET: string;

  /** Optional log level override. */
  LOG_LEVEL?: string;
}

export type {
  GitHubBotIssueCommentPayload as IssueCommentPayload,
  GitHubBotPullRequestOpenedPayload as PullRequestOpenedPayload,
  GitHubBotReviewCommentPayload as ReviewCommentPayload,
  GitHubBotReviewRequestedPayload as ReviewRequestedPayload,
} from "@open-inspect/shared";
