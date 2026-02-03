# =============================================================================
# Provider Authentication
# =============================================================================

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, KV, R2, and D1 permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID (optional, for custom domains)"
  type        = string
  default     = null
}

variable "cloudflare_worker_subdomain" {
  description = "Cloudflare Workers subdomain (account-specific, found in Workers dashboard)"
  type        = string
}

variable "vercel_api_token" {
  description = "Vercel API token"
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team ID"
  type        = string
}

variable "modal_token_id" {
  description = "Modal API token ID"
  type        = string
  sensitive   = true
}

variable "modal_token_secret" {
  description = "Modal API token secret"
  type        = string
  sensitive   = true
}

variable "modal_workspace" {
  description = "Modal workspace name (used in endpoint URLs)"
  type        = string
}

# =============================================================================
# GitHub OAuth App Credentials
# =============================================================================

variable "github_client_id" {
  description = "GitHub OAuth App client ID"
  type        = string
}

variable "github_client_secret" {
  description = "GitHub OAuth App client secret"
  type        = string
  sensitive   = true
}

# =============================================================================
# GitHub App Credentials (for Modal sandbox)
# =============================================================================

variable "github_app_id" {
  description = "GitHub App ID"
  type        = string
}

variable "github_app_private_key" {
  description = "GitHub App private key (PKCS#8 format)"
  type        = string
  sensitive   = true
}

variable "github_app_installation_id" {
  description = "GitHub App installation ID"
  type        = string
}

# =============================================================================
# Slack App Credentials
# =============================================================================

variable "slack_bot_token" {
  description = "Slack Bot OAuth token (xoxb-...)"
  type        = string
  sensitive   = true
}

variable "slack_signing_secret" {
  description = "Slack app signing secret"
  type        = string
  sensitive   = true
}

# =============================================================================
# API Keys
# =============================================================================

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude"
  type        = string
  sensitive   = true
}

# =============================================================================
# Security Secrets
# =============================================================================

variable "token_encryption_key" {
  description = "Key for encrypting tokens (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
}

variable "repo_secrets_encryption_key" {
  description = "Key for encrypting repo secrets in D1 (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
}

variable "internal_callback_secret" {
  description = "Shared secret for internal service communication (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
}

variable "modal_api_secret" {
  description = "Shared secret for authenticating control plane to Modal API calls (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
}

variable "nextauth_secret" {
  description = "NextAuth.js secret (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
}

# =============================================================================
# Configuration
# =============================================================================

variable "deployment_name" {
  description = "Unique deployment name used in URLs and resource names. Use something unique like your GitHub username or company name (e.g., 'acme', 'johndoe'). This will create URLs like: open-inspect-{deployment_name}.vercel.app"
  type        = string
}

variable "enable_durable_object_bindings" {
  description = "Enable DO bindings. For initial deployment: set to false (applies migrations), then set to true (adds bindings)."
  type        = bool
  default     = true
}

variable "enable_service_bindings" {
  description = "Enable service bindings. Set false for initial deployment if target workers don't exist yet."
  type        = bool
  default     = true
}

variable "project_root" {
  description = "Root path to the project repository"
  type        = string
  default     = "../../../"
}

# =============================================================================
# Access Control
# =============================================================================

variable "allowed_users" {
  description = "Comma-separated list of GitHub usernames allowed to sign in (empty = allow all)"
  type        = string
  default     = ""
}

variable "allowed_email_domains" {
  description = "Comma-separated list of email domains allowed to sign in (e.g., 'example.com,corp.io'). Empty = allow all domains."
  type        = string
  default     = ""
}
