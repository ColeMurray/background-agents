# =============================================================================
# Open-Inspect - Production Environment
# =============================================================================
# This configuration deploys the complete Open-Inspect infrastructure:
# - Cloudflare Workers (control-plane, slack-bot)
# - Cloudflare KV Namespaces
# - Web App (Vercel or Cloudflare Workers via OpenNext, controlled by web_platform)
# - Modal Sandbox Infrastructure
# =============================================================================

locals {
  name_suffix = var.deployment_name

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  # Web app URL depends on deployment platform
  web_app_url = var.web_platform == "cloudflare" ? (
    "https://open-inspect-web-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
    ) : (
    "https://open-inspect-${local.name_suffix}.vercel.app"
  )

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
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
  count  = var.enable_slack_bot ? 1 : 0
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-slack-kv-${local.name_suffix}"
}

module "linear_kv" {
  count  = var.enable_linear_bot ? 1 : 0
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-linear-kv-${local.name_suffix}"
}

# =============================================================================
# Cloudflare D1 Database
# =============================================================================

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-${local.name_suffix}"

  read_replication = {
    mode = "disabled"
  }
}

resource "null_resource" "d1_migrations" {
  depends_on = [cloudflare_d1_database.main]

  triggers = {
    database_id = cloudflare_d1_database.main.id
    migrations_sha = sha256(join(",", [
      for f in sort(fileset("${var.project_root}/terraform/d1/migrations", "*.sql")) :
      filesha256("${var.project_root}/terraform/d1/migrations/${f}")
    ]))
  }

  provisioner "local-exec" {
    command     = "bash scripts/d1-migrate.sh ${cloudflare_d1_database.main.name} terraform/d1/migrations"
    working_dir = var.project_root

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
    }
  }
}

# =============================================================================
# Cloudflare Workers
# =============================================================================

# Build control-plane worker bundle (only runs during apply, not plan)
resource "null_resource" "control_plane_build" {
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

module "control_plane_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-control-plane-${local.name_suffix}"
  script_path = local.control_plane_script_path

  kv_namespaces = [
    {
      binding_name = "REPOS_CACHE"
      namespace_id = module.session_index_kv.namespace_id
    }
  ]

  d1_databases = [
    {
      binding_name = "DB"
      database_id  = cloudflare_d1_database.main.id
    }
  ]

  service_bindings = concat(
    var.enable_slack_bot ? [
      {
        binding_name = "SLACK_BOT"
        service_name = module.slack_bot_worker[0].worker_name
      }
    ] : [],
    var.enable_linear_bot ? [
      {
        binding_name = "LINEAR_BOT"
        service_name = module.linear_bot_worker[0].worker_name
      }
    ] : []
  )

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "GITHUB_CLIENT_ID", value = var.github_client_id },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "WORKER_URL", value = local.control_plane_url },
    { name = "MODAL_WORKSPACE", value = var.modal_workspace },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
  ]

  secrets = [
    { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
    { name = "TOKEN_ENCRYPTION_KEY", value = var.token_encryption_key },
    { name = "REPO_SECRETS_ENCRYPTION_KEY", value = var.repo_secrets_encryption_key },
    { name = "MODAL_TOKEN_ID", value = var.modal_token_id },
    { name = "MODAL_TOKEN_SECRET", value = var.modal_token_secret },
    { name = "MODAL_API_SECRET", value = var.modal_api_secret },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
    # GitHub App credentials for /repos endpoint (listInstallationRepositories)
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
    { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
  ]

  durable_objects = [
    { binding_name = "SESSION", class_name = "SessionDO" }
  ]

  enable_durable_object_bindings = var.enable_durable_object_bindings

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]
  migration_tag       = "v1"

  depends_on = [null_resource.control_plane_build, module.session_index_kv, null_resource.d1_migrations, module.linear_bot_worker]
}

# Build slack-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "slack_bot_build" {
  count = var.enable_slack_bot ? 1 : 0

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
  count  = var.enable_slack_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-slack-bot-${local.name_suffix}"
  script_path = local.slack_bot_script_path

  kv_namespaces = [
    {
      binding_name = "SLACK_KV"
      namespace_id = module.slack_kv[0].namespace_id
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

  depends_on = [null_resource.slack_bot_build[0], module.slack_kv[0]]
}

# Build github-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "github_bot_build" {
  count = var.enable_github_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/github-bot"
  }
}

module "github_bot_worker" {
  count  = var.enable_github_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-github-bot-${local.name_suffix}"
  script_path = local.github_bot_script_path

  service_bindings = [
    {
      binding_name = "CONTROL_PLANE"
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "DEFAULT_MODEL", value = "anthropic/claude-haiku-4-5" },
    { name = "GITHUB_BOT_USERNAME", value = var.github_bot_username },
  ]

  secrets = [
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
    { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
    { name = "GITHUB_WEBHOOK_SECRET", value = var.github_webhook_secret },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.github_bot_build[0], module.control_plane_worker]
}

# =============================================================================
# Linear Bot Worker
# =============================================================================

# Build linear-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "linear_bot_build" {
  count = var.enable_linear_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/linear-bot"
  }
}

module "linear_bot_worker" {
  count  = var.enable_linear_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-linear-bot-${local.name_suffix}"
  script_path = local.linear_bot_script_path

  kv_namespaces = [
    {
      binding_name = "LINEAR_KV"
      namespace_id = module.linear_kv[0].namespace_id
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
    { name = "DEFAULT_MODEL", value = "claude-sonnet-4-6" },
    { name = "LINEAR_CLIENT_ID", value = var.linear_client_id },
    { name = "WORKER_URL", value = "https://open-inspect-linear-bot-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev" },
  ]

  secrets = [
    { name = "LINEAR_WEBHOOK_SECRET", value = var.linear_webhook_secret },
    { name = "LINEAR_CLIENT_SECRET", value = var.linear_client_secret },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "LINEAR_API_KEY", value = var.linear_api_key },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.linear_bot_build[0], module.linear_kv[0]]
}

# =============================================================================
# Web App — Vercel (when web_platform = "vercel")
# =============================================================================

module "web_app" {
  count  = var.web_platform == "vercel" ? 1 : 0
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

# Verify the Vercel production URL matches our hardcoded pattern. If Vercel
# assigns a different domain (e.g., due to naming conflicts), NEXTAUTH_URL and
# cross-service references will silently break.
check "vercel_url_matches" {
  assert {
    condition = (
      var.web_platform != "vercel" ||
      length(module.web_app) == 0 ||
      try(module.web_app[0].production_url == local.web_app_url, true)
    )
    error_message = "Vercel assigned URL '${try(module.web_app[0].production_url, "n/a")}' but local.web_app_url is '${local.web_app_url}'. Update locals or set a custom domain."
  }
}

# =============================================================================
# Web App — Cloudflare Workers via OpenNext (when web_platform = "cloudflare")
# =============================================================================

# Build the web app with OpenNext for Cloudflare Workers
resource "null_resource" "web_app_cloudflare_build" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build -w @open-inspect/shared && npm run build:cloudflare -w @open-inspect/web"
    working_dir = var.project_root

    environment = {
      # NEXT_PUBLIC_* vars must be set at build time (inlined into client bundle)
      NEXT_PUBLIC_WS_URL = local.ws_url
    }
  }
}

# Upload secrets to the Cloudflare Worker (only re-runs when secrets change).
# Must run after deploy — wrangler secret put requires the worker to exist.
resource "null_resource" "web_app_cloudflare_secrets" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    secrets_hash = sha256(join(",", [
      var.github_client_secret,
      var.nextauth_secret,
      var.internal_callback_secret,
    ]))
  }

  provisioner "local-exec" {
    command     = "bash scripts/wrangler-secrets.sh"
    working_dir = var.project_root

    environment = {
      CLOUDFLARE_API_TOKEN     = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID    = var.cloudflare_account_id
      WORKER_NAME              = "open-inspect-web-${local.name_suffix}"
      GITHUB_CLIENT_SECRET     = var.github_client_secret
      NEXTAUTH_SECRET          = var.nextauth_secret
      INTERNAL_CALLBACK_SECRET = var.internal_callback_secret
    }
  }

  depends_on = [null_resource.web_app_cloudflare_deploy]
}

# Generate a production wrangler config with the correct service binding name.
# This avoids mutating the checked-in wrangler.toml (which defaults to local dev).
resource "local_file" "web_app_wrangler_production" {
  count    = var.web_platform == "cloudflare" ? 1 : 0
  filename = "${var.project_root}/packages/web/wrangler.production.toml"
  content  = <<-TOML
    name = "open-inspect-web-${local.name_suffix}"
    main = ".open-next/worker.js"
    compatibility_date = "2025-08-15"
    compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

    [vars]
    GITHUB_CLIENT_ID = "${var.github_client_id}"
    NEXTAUTH_URL = "${local.web_app_url}"
    CONTROL_PLANE_URL = "${local.control_plane_url}"
    NEXT_PUBLIC_WS_URL = "${local.ws_url}"
    ALLOWED_USERS = "${var.allowed_users}"
    ALLOWED_EMAIL_DOMAINS = "${var.allowed_email_domains}"

    [assets]
    directory = ".open-next/assets"
    binding = "ASSETS"

    [[services]]
    binding = "CONTROL_PLANE_WORKER"
    service = "open-inspect-control-plane-${local.name_suffix}"
  TOML
}

# Deploy the OpenNext bundle to Cloudflare Workers
resource "null_resource" "web_app_cloudflare_deploy" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npx wrangler deploy --config wrangler.production.toml"
    working_dir = "${var.project_root}/packages/web"

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [
    null_resource.web_app_cloudflare_build,
    module.control_plane_worker,
    local_file.web_app_wrangler_production,
  ]
}

# =============================================================================
# Modal Sandbox Infrastructure
# =============================================================================

# Calculate hash of Modal source files for change detection
# Uses sha256sum (Linux) or shasum (macOS) for cross-platform compatibility
# Includes both .py and .js files (sandbox plugins are JavaScript)
data "external" "modal_source_hash" {
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

  modal_token_id     = var.modal_token_id
  modal_token_secret = var.modal_token_secret

  app_name      = "open-inspect"
  workspace     = var.modal_workspace
  deploy_path   = "${var.project_root}/packages/modal-infra"
  deploy_module = "deploy"
  source_hash   = data.external.modal_source_hash.result.hash

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
        MODAL_API_SECRET            = var.modal_api_secret
        INTERNAL_CALLBACK_SECRET    = var.internal_callback_secret
        ALLOWED_CONTROL_PLANE_HOSTS = local.control_plane_host
        CONTROL_PLANE_URL           = local.control_plane_url
      }
    }
  ]
}
