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
        service_name = "open-inspect-slack-bot-${local.name_suffix}"
      }
    ] : [],
    var.enable_linear_bot ? [
      {
        binding_name = "LINEAR_BOT"
        service_name = "open-inspect-linear-bot-${local.name_suffix}"
      }
    ] : [],
    var.enable_teams_bot ? [
      {
        binding_name = "TEAMS_BOT"
        service_name = "open-inspect-teams-bot-${local.name_suffix}"
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

  depends_on = [null_resource.control_plane_build, module.session_index_kv, null_resource.d1_migrations, module.linear_bot_worker, module.teams_bot_worker]
}
