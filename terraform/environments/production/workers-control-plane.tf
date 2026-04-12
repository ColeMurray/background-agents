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

  r2_buckets = [
    {
      binding_name = "MEDIA_BUCKET"
      bucket_name  = cloudflare_r2_bucket.media.name
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
    ] : []
  )

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = concat(
    [
      { name = "GITHUB_CLIENT_ID", value = var.github_client_id },
      { name = "WEB_APP_URL", value = local.web_app_url },
      { name = "WORKER_URL", value = local.control_plane_url },
      { name = "DEPLOYMENT_NAME", value = var.deployment_name },
      { name = "SANDBOX_PROVIDER", value = var.sandbox_provider },
      { name = "R2_BUCKET_NAME", value = cloudflare_r2_bucket.media.name },
      { name = "R2_ACCOUNT_ID", value = var.cloudflare_account_id },
    ],
    local.use_modal_backend ? [{ name = "MODAL_WORKSPACE", value = var.modal_workspace }] : [],
    local.use_daytona_backend ? [
      { name = "DAYTONA_API_URL", value = var.daytona_api_url },
      { name = "DAYTONA_BASE_SNAPSHOT", value = var.daytona_base_snapshot },
    ] : [],
    local.use_daytona_backend && var.daytona_target != "" ? [
      { name = "DAYTONA_TARGET", value = var.daytona_target },
    ] : []
  )

  secrets = concat(
    [
      { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
      { name = "TOKEN_ENCRYPTION_KEY", value = var.token_encryption_key },
      { name = "REPO_SECRETS_ENCRYPTION_KEY", value = var.repo_secrets_encryption_key },
      { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
      # GitHub App credentials for /repos endpoint (listInstallationRepositories)
      { name = "GITHUB_APP_ID", value = var.github_app_id },
      { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
      { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
      { name = "R2_ACCESS_KEY_ID", value = cloudflare_account_token.control_plane_media_read.id },
      { name = "R2_SECRET_ACCESS_KEY", value = cloudflare_account_token.control_plane_media_read.value },
    ],
    local.use_modal_backend ? [
      { name = "MODAL_TOKEN_ID", value = var.modal_token_id },
      { name = "MODAL_TOKEN_SECRET", value = var.modal_token_secret },
      { name = "MODAL_API_SECRET", value = var.modal_api_secret },
    ] : [],
    local.use_daytona_backend ? [
      { name = "DAYTONA_API_KEY", value = var.daytona_api_key },
    ] : []
  )

  durable_objects = [
    { binding_name = "SESSION", class_name = "SessionDO" },
    { binding_name = "SCHEDULER", class_name = "SchedulerDO" },
  ]

  enable_durable_object_bindings = var.enable_durable_object_bindings

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]
  migration_tag       = var.control_plane_migration_tag
  migration_old_tag   = var.control_plane_migration_old_tag
  new_sqlite_classes  = var.control_plane_new_sqlite_classes

  cron_triggers = ["* * * * *"]

  depends_on = [
    null_resource.control_plane_build,
    module.session_index_kv,
    null_resource.d1_migrations,
    module.linear_bot_worker,
    cloudflare_r2_bucket_cors.media,
  ]
}
