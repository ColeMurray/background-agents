# =============================================================================
# Open-Inspect - Production Environment
# =============================================================================
# This configuration deploys the complete Open-Inspect infrastructure:
# - Cloudflare Workers (control-plane, slack-bot)
# - Cloudflare KV Namespaces
# - Vercel Web App
# - Sandbox Infrastructure (Modal or Cloudflare, based on sandbox_backend var)
# =============================================================================

locals {
  name_suffix = var.deployment_name

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  web_app_url        = "https://open-inspect-${local.name_suffix}.vercel.app"
  ws_url             = "wss://${local.control_plane_host}"

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"

  # Sandbox backend configuration
  use_modal_backend     = var.sandbox_backend == "modal"
  use_cloudflare_backend = var.sandbox_backend == "cloudflare"
}

# =============================================================================
# Cloudflare KV Namespaces
# =============================================================================

module "session_index_kv" {
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-session-index-${local.name_suffix}"
}

module "slack_kv" {
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-slack-kv-${local.name_suffix}"
}

# =============================================================================
# Cloudflare Workers
# =============================================================================

# Build control-plane worker bundle (only for Modal backend - Cloudflare uses wrangler)
resource "null_resource" "control_plane_build" {
  count = local.use_modal_backend ? 1 : 0

  triggers = {
    # Rebuild when source files change - use timestamp to always check
    # In CI, this ensures fresh builds; locally, npm handles caching
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/control-plane"
  }
}

# Control plane worker (Modal backend only - uses Terraform provider)
# For Cloudflare backend, see cloudflare_sandbox module below (uses wrangler)
module "control_plane_worker" {
  source = "../../modules/cloudflare-worker"
  count  = local.use_modal_backend ? 1 : 0

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-control-plane-${local.name_suffix}"
  script_path = local.control_plane_script_path

  kv_namespaces = [
    {
      binding_name = "SESSION_INDEX"
      namespace_id = module.session_index_kv.namespace_id
    }
  ]

  service_bindings = [
    {
      binding_name = "SLACK_BOT"
      service_name = "open-inspect-slack-bot-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "GITHUB_CLIENT_ID", value = var.github_client_id },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "WORKER_URL", value = local.control_plane_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "SANDBOX_BACKEND", value = "modal" },
    { name = "MODAL_WORKSPACE", value = var.modal_workspace },
  ]

  secrets = [
    { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
    { name = "TOKEN_ENCRYPTION_KEY", value = var.token_encryption_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
    { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
    { name = "MODAL_TOKEN_ID", value = var.modal_token_id },
    { name = "MODAL_TOKEN_SECRET", value = var.modal_token_secret },
    { name = "MODAL_API_SECRET", value = var.modal_api_secret },
  ]

  durable_objects = [
    { binding_name = "SESSION", class_name = "SessionDO" }
  ]

  enable_durable_object_bindings = var.enable_durable_object_bindings

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]
  migration_tag       = "v1"

  depends_on = [null_resource.control_plane_build[0], module.session_index_kv]
}

# Build slack-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "slack_bot_build" {
  triggers = {
    # Rebuild when source files change - use timestamp to always check
    # In CI, this ensures fresh builds; locally, npm handles caching
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/slack-bot"
  }
}

module "slack_bot_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-slack-bot-${local.name_suffix}"
  script_path = local.slack_bot_script_path

  kv_namespaces = [
    {
      binding_name = "SLACK_KV"
      namespace_id = module.slack_kv.namespace_id
    }
  ]

  service_bindings = [
    {
      binding_name = "CONTROL_PLANE"
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "DEFAULT_MODEL", value = "claude-haiku-4-5" },
    { name = "CLASSIFICATION_MODEL", value = "claude-haiku-4-5" },
  ]

  secrets = [
    { name = "SLACK_BOT_TOKEN", value = var.slack_bot_token },
    { name = "SLACK_SIGNING_SECRET", value = var.slack_signing_secret },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  # Depends on control plane being deployed (either via TF provider or wrangler)
  depends_on = [
    null_resource.slack_bot_build,
    module.slack_kv,
    module.control_plane_worker,
    module.cloudflare_sandbox
  ]
}

# =============================================================================
# Vercel Web App
# =============================================================================

module "web_app" {
  source = "../../modules/vercel-project"

  project_name = "open-inspect-${local.name_suffix}"
  team_id      = var.vercel_team_id
  framework    = "nextjs"

  # No git_repository - deploy via CLI/CI instead of auto-deploy on push
  root_directory  = "packages/web"
  install_command = "cd ../.. && npm install && npm run build -w @open-inspect/shared"
  build_command   = "next build"

  environment_variables = [
    # GitHub OAuth
    {
      key       = "GITHUB_CLIENT_ID"
      value     = var.github_client_id
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "GITHUB_CLIENT_SECRET"
      value     = var.github_client_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # NextAuth
    {
      key       = "NEXTAUTH_URL"
      value     = local.web_app_url
      targets   = ["production"]
      sensitive = false
    },
    {
      key       = "NEXTAUTH_SECRET"
      value     = var.nextauth_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # Control Plane
    {
      key       = "CONTROL_PLANE_URL"
      value     = local.control_plane_url
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_WS_URL"
      value     = local.ws_url
      targets   = ["production", "preview"]
      sensitive = false
    },
    # Internal
    {
      key       = "INTERNAL_CALLBACK_SECRET"
      value     = var.internal_callback_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # Access Control
    {
      key       = "ALLOWED_USERS"
      value     = var.allowed_users
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "ALLOWED_EMAIL_DOMAINS"
      value     = var.allowed_email_domains
      targets   = ["production", "preview"]
      sensitive = false
    },
  ]
}

# =============================================================================
# Modal Sandbox Infrastructure (only when sandbox_backend = "modal")
# =============================================================================

# Calculate hash of Modal source files for change detection
# Uses sha256sum (Linux) or shasum (macOS) for cross-platform compatibility
# Includes both .py and .js files (sandbox plugins are JavaScript)
data "external" "modal_source_hash" {
  count = local.use_modal_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}/packages/modal-infra
    if command -v sha256sum &> /dev/null; then
      hash=$(find src -type f \( -name "*.py" -o -name "*.js" \) -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
    else
      hash=$(find src -type f \( -name "*.py" -o -name "*.js" \) -exec shasum -a 256 {} \; | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "modal_app" {
  source = "../../modules/modal-app"
  count  = local.use_modal_backend ? 1 : 0

  modal_token_id     = var.modal_token_id
  modal_token_secret = var.modal_token_secret

  app_name      = "open-inspect"
  workspace     = var.modal_workspace
  deploy_path   = "${var.project_root}/packages/modal-infra"
  deploy_module = "deploy"
  source_hash   = data.external.modal_source_hash[0].result.hash

  volume_name = "open-inspect-data"

  secrets = [
    {
      name = "llm-api-keys"
      values = {
        ANTHROPIC_API_KEY = var.anthropic_api_key
      }
    },
    {
      name = "github-app"
      values = {
        GITHUB_APP_ID              = var.github_app_id
        GITHUB_APP_PRIVATE_KEY     = var.github_app_private_key
        GITHUB_APP_INSTALLATION_ID = var.github_app_installation_id
      }
    },
    {
      name = "internal-api"
      values = {
        MODAL_API_SECRET             = var.modal_api_secret
        ALLOWED_CONTROL_PLANE_HOSTS  = local.control_plane_host
      }
    }
  ]
}

# =============================================================================
# Cloudflare Sandbox Infrastructure (only when sandbox_backend = "cloudflare")
# =============================================================================
# Uses wrangler CLI to deploy control-plane with container support
# (The Cloudflare Terraform provider doesn't support containers yet)

# Calculate hash of Cloudflare sandbox source files for change detection
data "external" "cloudflare_source_hash" {
  count = local.use_cloudflare_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}/packages
    if command -v sha256sum &> /dev/null; then
      hash=$(find control-plane/src sandbox/src -type f \( -name "*.ts" -o -name "*.js" \) -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
    else
      hash=$(find control-plane/src sandbox/src -type f \( -name "*.ts" -o -name "*.js" \) -exec shasum -a 256 {} \; | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "cloudflare_sandbox" {
  source = "../../modules/cloudflare-sandbox"
  count  = local.use_cloudflare_backend ? 1 : 0

  cloudflare_api_token  = var.cloudflare_api_token
  cloudflare_account_id = var.cloudflare_account_id

  worker_name        = "open-inspect-control-plane-${local.name_suffix}"
  control_plane_path = "${var.project_root}/packages/control-plane"
  source_hash        = data.external.cloudflare_source_hash[0].result.hash

  durable_objects = [
    { name = "SESSION", class_name = "SessionDO" }
  ]

  kv_namespaces = [
    { binding = "SESSION_INDEX", id = module.session_index_kv.namespace_id }
  ]

  environment_variables = {
    GITHUB_CLIENT_ID   = var.github_client_id
    WEB_APP_URL        = local.web_app_url
    WORKER_URL         = local.control_plane_url
    DEPLOYMENT_NAME    = var.deployment_name
    SANDBOX_BACKEND    = "cloudflare"
    SANDBOX_SLEEP_AFTER = "1h"
  }

  secrets = [
    { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
    { name = "TOKEN_ENCRYPTION_KEY", value = var.token_encryption_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
    { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
  ]

  depends_on = [module.session_index_kv]
}
