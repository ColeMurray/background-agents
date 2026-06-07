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

variable "cloudflare_custom_domain" {
  description = "Custom domain (hostname) to attach to the Cloudflare web Worker (optional). Requires web_platform = 'cloudflare' and cloudflare_zone_id. e.g. 'app.example.com'"
  type        = string
  default     = null

  validation {
    condition = (
      var.cloudflare_custom_domain == null ||
      trimspace(var.cloudflare_custom_domain) == "" ||
      can(regex("(?i)^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.cloudflare_custom_domain))
    )
    error_message = "cloudflare_custom_domain must be a bare hostname such as 'app.example.com' — no scheme, port, path, trailing dot, or whitespace."
  }
}

variable "cloudflare_worker_subdomain" {
  description = "Cloudflare Workers account subdomain (e.g. 'myaccount' — .workers.dev is appended automatically)"
  type        = string
}

variable "vercel_api_token" {
  description = "Vercel API token (required only when web_platform = 'vercel'). Do NOT set to empty string — the Vercel provider validates this on init even when no Vercel resources are created. Leave unset to use the built-in dummy token for Cloudflare-only deployments."
  type        = string
  sensitive   = true
  default     = "000000000000000000000000"
}

variable "vercel_team_id" {
  description = "Vercel team ID (required only when web_platform = 'vercel'). Leave unset when using Cloudflare."
  type        = string
  default     = "unused"
}

variable "modal_token_id" {
  description = "Modal API token ID"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "modal" || length(var.modal_token_id) > 0
    error_message = "modal_token_id must be set when sandbox_provider = 'modal'."
  }
}

variable "modal_token_secret" {
  description = "Modal API token secret"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "modal" || length(var.modal_token_secret) > 0
    error_message = "modal_token_secret must be set when sandbox_provider = 'modal'."
  }
}

variable "modal_workspace" {
  description = "Modal workspace name"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "modal" || length(var.modal_workspace) > 0
    error_message = "modal_workspace must be set when sandbox_provider = 'modal'."
  }
}

variable "modal_environment" {
  description = "Modal environment name used by the Modal CLI"
  type        = string
  default     = "main"

  validation {
    condition     = var.sandbox_provider != "modal" || (length(trimspace(var.modal_environment)) > 0 && can(regex("^[^:/\\\\]+$", var.modal_environment)))
    error_message = "modal_environment must be set and must not contain colons, slashes, or backslashes when sandbox_provider = 'modal'."
  }
}

variable "modal_environment_web_suffix" {
  description = "Modal environment web suffix used in endpoint URLs. Use lowercase letters, digits, and dashes, or leave empty for the environment with no web suffix."
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "modal" || can(regex("^$|^[a-z0-9-]+$", var.modal_environment_web_suffix))
    error_message = "modal_environment_web_suffix must be empty or contain only lowercase letters, digits, and dashes when sandbox_provider = 'modal'."
  }
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
# Google OAuth Credentials (Optional — enables "Sign in with Google")
# =============================================================================
# Set both google_client_id and google_client_secret to enable Google login for
# non-developer users (PMs, support agents). Leave both empty for GitHub-only
# deployments, which stay byte-unchanged. A Google session authenticates the user
# but carries no SCM credentials; git operations continue to use the shared
# GitHub App installation, and PRs fall back to the App bot.

variable "google_client_id" {
  description = "Google OAuth 2.0 client ID. Set together with google_client_secret to enable Google login; leave both empty to keep the deployment GitHub-only."
  type        = string
  default     = ""

  validation {
    condition     = (var.google_client_id == "") == (var.google_client_secret == "")
    error_message = "google_client_id and google_client_secret must be set together (both non-empty) or both left empty. Setting only one silently disables Google login."
  }
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 client secret. Required together with google_client_id."
  type        = string
  sensitive   = true
  default     = ""
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
# GitHub Bot Configuration
# =============================================================================

variable "enable_github_bot" {
  description = "Enable the GitHub bot worker. Requires github_webhook_secret and github_bot_username."
  type        = bool
  default     = false

  validation {
    condition     = var.enable_github_bot == false || (length(var.github_webhook_secret) > 0 && length(var.github_bot_username) > 0)
    error_message = "When enable_github_bot is true, github_webhook_secret and github_bot_username must be non-empty."
  }
}

variable "github_webhook_secret" {
  description = "Shared secret for verifying GitHub webhook signatures (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_bot_username" {
  description = "GitHub App bot username for @mention detection (e.g., 'my-app[bot]')"
  type        = string
  default     = ""
}

# =============================================================================
# Slack App Credentials
# =============================================================================

variable "enable_slack_bot" {
  description = "Enable the Slack bot worker. Set to false to skip deployment."
  type        = bool
  default     = true

  validation {
    condition     = var.enable_slack_bot == false || (length(var.slack_bot_token) > 0 && length(var.slack_signing_secret) > 0)
    error_message = "When enable_slack_bot is true, slack_bot_token and slack_signing_secret must be non-empty."
  }
}

variable "slack_triggers_enabled" {
  description = "Kill switch for Slack channel-message automation triggers. When false (default), the slack-bot ignores channel messages and forwards nothing — the feature ships dark. Flip to true only after completing the rollout verification."
  type        = bool
  default     = false
}

variable "slack_bot_token" {
  description = "Slack Bot OAuth token (xoxb-...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "slack_signing_secret" {
  description = "Slack app signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

# =============================================================================
# Linear Agent Credentials
# =============================================================================

variable "enable_linear_bot" {
  description = "Enable the Linear bot worker. Requires linear_client_id, linear_client_secret, and linear_webhook_secret."
  type        = bool
  default     = false

  validation {
    condition = var.enable_linear_bot == false || (
      length(var.linear_client_id) > 0 &&
      length(var.linear_client_secret) > 0 &&
      length(var.linear_webhook_secret) > 0
    )
    error_message = "When enable_linear_bot is true, linear_client_id, linear_client_secret, and linear_webhook_secret must be non-empty."
  }
}

variable "linear_client_id" {
  description = "Linear OAuth Application Client ID (from Settings → API → Applications)"
  type        = string
  default     = ""
}

variable "linear_client_secret" {
  description = "Linear OAuth Application Client Secret"
  type        = string
  default     = ""
  sensitive   = true
}

variable "linear_webhook_secret" {
  description = "Linear webhook signing secret (from the OAuth Application config)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "linear_api_key" {
  description = "Linear API key for fallback comment posting"
  type        = string
  default     = ""
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
  default     = ""

  validation {
    condition     = var.sandbox_provider != "modal" || length(var.modal_api_secret) > 0
    error_message = "modal_api_secret must be set when sandbox_provider = 'modal'."
  }
}

variable "daytona_api_url" {
  description = "Base URL for the Daytona REST API (e.g. https://app.daytona.io/api)"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_api_url) > 0
    error_message = "daytona_api_url must be set when sandbox_provider = 'daytona'."
  }
}

variable "daytona_api_key" {
  description = "API key for Daytona REST API (Bearer auth)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_api_key) > 0
    error_message = "daytona_api_key must be set when sandbox_provider = 'daytona'."
  }
}

variable "daytona_base_snapshot" {
  description = "Named Daytona snapshot used for fresh sandbox creation"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_base_snapshot) > 0
    error_message = "daytona_base_snapshot must be set when sandbox_provider = 'daytona'."
  }
}

variable "daytona_target" {
  description = "Optional Daytona target name"
  type        = string
  default     = ""
}

variable "islo_api_key" {
  description = "API key for Islo sandbox compute"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "islo" || length(var.islo_api_key) > 0
    error_message = "islo_api_key must be set when sandbox_provider = 'islo'."
  }
}

variable "islo_base_url" {
  description = "Optional Islo API base URL. Leave empty to use https://api.islo.dev."
  type        = string
  default     = ""
}

variable "islo_base_snapshot" {
  description = "Named Islo snapshot used for fresh sandbox creation"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "islo" || length(var.islo_base_snapshot) > 0
    error_message = "islo_base_snapshot must be set when sandbox_provider = 'islo'."
  }
}

variable "islo_vcpus" {
  description = "Number of vCPUs for Islo sandboxes"
  type        = number
  default     = 2

  validation {
    condition     = var.islo_vcpus > 0 && floor(var.islo_vcpus) == var.islo_vcpus
    error_message = "islo_vcpus must be a positive integer."
  }
}

variable "islo_memory_mb" {
  description = "Memory in MB for Islo sandboxes"
  type        = number
  default     = 4096

  validation {
    condition     = var.islo_memory_mb > 0 && floor(var.islo_memory_mb) == var.islo_memory_mb
    error_message = "islo_memory_mb must be a positive integer."
  }
}

variable "islo_disk_gb" {
  description = "Disk size in GB for Islo sandboxes"
  type        = number
  default     = 10

  validation {
    condition     = var.islo_disk_gb > 0 && floor(var.islo_disk_gb) == var.islo_disk_gb
    error_message = "islo_disk_gb must be a positive integer."
  }
}

variable "islo_workdir" {
  description = "Working directory for Islo sandbox runtime commands"
  type        = string
  default     = "/workspace"
}

variable "islo_start_command" {
  description = "Command to start the Open-Inspect runtime in Islo. Use a JSON string array or shell command."
  type        = string
  default     = ""
}

variable "islo_start_user" {
  description = "Optional user to run the Islo runtime start command as"
  type        = string
  default     = ""
}

variable "islo_gateway_profile" {
  description = "Optional Islo gateway profile name or ID"
  type        = string
  default     = ""
}

variable "islo_share_ttl_seconds" {
  description = "Optional TTL in seconds for Islo share URLs"
  type        = number
  default     = 0
}

variable "opencomputer_api_url" {
  description = "Base URL for the OpenComputer REST API (e.g. https://api.opencomputer.dev)"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "opencomputer" || length(trimspace(var.opencomputer_api_url)) > 0
    error_message = "opencomputer_api_url must be set when sandbox_provider = 'opencomputer'."
  }
}

variable "opencomputer_api_key" {
  description = "API key for OpenComputer REST API (X-API-Key auth)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "opencomputer" || length(trimspace(var.opencomputer_api_key)) > 0
    error_message = "opencomputer_api_key must be set when sandbox_provider = 'opencomputer'."
  }
}

variable "opencomputer_template" {
  description = "Optional manual OpenComputer template/snapshot name to pin. When empty, Terraform builds and manages the base snapshot from the runtime source (like the Vercel and Modal base images)."
  type        = string
  default     = ""
}

variable "vercel_sandbox_token" {
  description = "Vercel API token for the Vercel Sandbox API"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "vercel" || length(var.vercel_sandbox_token) > 0
    error_message = "vercel_sandbox_token must be set when sandbox_provider = 'vercel'."
  }
}

variable "vercel_sandbox_project_id" {
  description = "Vercel project ID used to scope Sandbox API calls"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "vercel" || length(var.vercel_sandbox_project_id) > 0
    error_message = "vercel_sandbox_project_id must be set when sandbox_provider = 'vercel'."
  }
}

variable "vercel_sandbox_team_id" {
  description = "Optional Vercel team ID used to scope Sandbox API calls"
  type        = string
  default     = ""
}

variable "vercel_sandbox_api_base_url" {
  description = "Optional Vercel Sandbox API base URL override"
  type        = string
  default     = ""
}

variable "vercel_base_snapshot_id" {
  description = "Optional manual Vercel Sandbox snapshot ID containing the Open-Inspect base runtime. When set, Terraform skips managed Vercel base snapshot builds."
  type        = string
  default     = ""
}

variable "vercel_sandbox_runtime" {
  description = "Vercel Sandbox runtime identifier"
  type        = string
  default     = "node24"
}

variable "vercel_snapshot_expiration_ms" {
  description = "Vercel Sandbox snapshot expiration in milliseconds; 0 means no expiration"
  type        = number
  default     = 0
}

variable "nextauth_secret" {
  description = "NextAuth.js secret (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
}

# =============================================================================
# Configuration
# =============================================================================

variable "sandbox_provider" {
  description = "Sandbox backend for session execution: 'modal', 'daytona', 'vercel', 'opencomputer', or 'islo'"
  type        = string
  default     = "modal"

  validation {
    condition     = contains(["modal", "daytona", "vercel", "opencomputer", "islo"], var.sandbox_provider)
    error_message = "sandbox_provider must be 'modal', 'daytona', 'vercel', 'opencomputer', or 'islo'."
  }
}

variable "sandbox_inactivity_timeout_ms" {
  description = "Milliseconds of sandbox inactivity before OpenInspect snapshots and stops the sandbox when no clients are connected."
  type        = number
  default     = 600000
}

variable "web_platform" {
  description = "Platform for the web app deployment: 'vercel' or 'cloudflare' (OpenNext)"
  type        = string
  default     = "vercel"

  validation {
    condition     = contains(["vercel", "cloudflare"], var.web_platform)
    error_message = "web_platform must be 'vercel' or 'cloudflare'."
  }
}

variable "deployment_name" {
  description = "Unique deployment name used in URLs and resource names. Use something unique like your GitHub username or company name (e.g., 'acme', 'johndoe'). This will create URLs like: open-inspect-{deployment_name}.vercel.app"
  type        = string
}

variable "app_name" {
  description = "Display name shown in the web UI tab title, sign-in page, bot messages (Slack, Linear), PR body footer, and outbound HTTP User-Agent headers."
  type        = string
  default     = "Open-Inspect"
}

variable "app_short_name" {
  description = "Short brand label shown only in the web sidebar header. Defaults to 'Inspect' to keep the sidebar visually compact."
  type        = string
  default     = "Inspect"
}

variable "app_icon_url" {
  description = "Optional URL (absolute or root-relative) to a custom logo image for the command menu and browser favicon. Leave empty to use the built-in favicon and default in-app icon."
  type        = string
  default     = ""
}

variable "enable_durable_object_bindings" {
  description = "Enable DO bindings. For initial deployment: set to false (applies migrations), then set to true (adds bindings)."
  type        = bool
  default     = true
}

variable "control_plane_migration_tag" {
  description = "Current migration tag for control plane DO migrations"
  type        = string
  default     = "v1"
}

variable "control_plane_migration_old_tag" {
  description = "Previous migration tag for control plane DO migrations (null for fresh deployments)"
  type        = string
  default     = null
}

variable "control_plane_new_sqlite_classes" {
  description = "DO classes new in this control plane migration step (empty means treat all configured classes as new)"
  type        = list(string)
  default     = []
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
# R2 Storage
# =============================================================================

variable "r2_media_location" {
  description = "Cloudflare R2 location hint for the media bucket (e.g. ENAM, WNAM, APAC, WEUR, EEUR)"
  type        = string
  default     = "ENAM"
}

variable "r2_media_bucket_name" {
  description = "Override the R2 media bucket name. Leave empty to use the default 'open-inspect-media-<deployment_name>'. Set this when the bucket must be pre-created out-of-band (e.g. when the Terraform credentials cannot create R2 buckets)."
  type        = string
  default     = ""
}

# =============================================================================
# Access Control
# =============================================================================
# Four allowlists gate sign-in; a user is admitted if they match ANY configured
# allowlist. Leave them all empty only with unsafe_allow_all_users = true.

variable "allowed_users" {
  description = "Comma-separated list of GitHub usernames allowed to sign in. Leave empty only when another allowlist (allowed_email_domains, allowed_emails, allowed_github_orgs) is set or unsafe_allow_all_users is true."
  type        = string
  default     = ""
}

variable "allowed_email_domains" {
  description = "Comma-separated list of email domains allowed to sign in (e.g., 'example.com,corp.io'). Matches any provider's verified email. Leave empty only when another allowlist (allowed_users, allowed_emails, allowed_github_orgs) is set or unsafe_allow_all_users is true."
  type        = string
  default     = ""
}

variable "allowed_emails" {
  description = "Comma-separated list of exact email addresses allowed to sign in, matched case-insensitively against any provider's verified email. Use this for individual users on shared domains (e.g. one person@gmail.com) where allowed_email_domains would be too broad. Leave empty only when another allowlist is set or unsafe_allow_all_users is true."
  type        = string
  default     = ""
}

variable "allowed_github_orgs" {
  description = "Comma-separated list of GitHub organization logins whose active members are allowed to sign in. The signing-in user's OAuth token is checked against GitHub's membership API at sign-in (read:org is requested only when this is set) and requires GitHub App Organization permissions: Members read-only. Leave empty only when another allowlist is set or unsafe_allow_all_users is true."
  type        = string
  default     = ""
}

variable "unsafe_allow_all_users" {
  description = "Bypass Terraform's access-control safety check and allow any authenticated user to sign in when all allowlists are empty. Set to true only for intentionally open deployments."
  type        = bool
  default     = false
}
