/**
 * Environment bindings for the GitHub Bot Cloudflare Worker.
 */
export interface Env {
  /** Service binding to the control plane worker. */
  CONTROL_PLANE: Fetcher;

  /** Deployment name for logging/identification. */
  DEPLOYMENT_NAME: string;

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

/**
 * Webhook payload types — narrow types extracted from the GitHub webhook
 * event schema containing only the fields the bot reads.
 */

export interface PullRequestOpenedPayload {
  action: "opened";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
    draft: boolean;
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string };
}

export interface ReviewRequestedPayload {
  action: "review_requested";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  requested_reviewer?: { login: string };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string };
}

export interface IssueCommentPayload {
  action: "created";
  issue: {
    number: number;
    title: string;
    pull_request?: { url: string };
  };
  comment: {
    id: number;
    body: string;
    user: { login: string };
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string };
}

export interface ReviewCommentPayload {
  action: "created";
  pull_request: {
    number: number;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  comment: {
    id: number;
    body: string;
    path: string;
    diff_hunk: string;
    position: number | null;
    user: { login: string };
  };
  repository: { owner: { login: string }; name: string; private: boolean };
  sender: { login: string };
}
