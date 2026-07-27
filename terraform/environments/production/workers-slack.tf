# =============================================================================
# Slack Bot Worker
# =============================================================================

resource "cloudflare_queue" "slack_completion_delivery" {
  count = var.enable_slack_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-slack-completion-${local.name_suffix}"
}

resource "cloudflare_queue" "slack_completion_delivery_dlq" {
  count = var.enable_slack_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-slack-completion-dlq-${local.name_suffix}"
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

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-slack-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
  script_path      = local.slack_bot_script_path

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

  queue_bindings = [
    {
      binding_name = "SLACK_COMPLETION_QUEUE"
      queue_name   = cloudflare_queue.slack_completion_delivery[0].queue_name
    }
  ]

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "APP_NAME", value = var.app_name },
    { name = "DEFAULT_MODEL", value = "claude-haiku-4-5" },
    { name = "CLASSIFICATION_MODEL", value = "claude-haiku-4-5" },
    # Kill switch for Slack channel-message triggers; the bot only ingests/
    # forwards channel messages when this is exactly "true" (dark by default).
    { name = "SLACK_TRIGGERS_ENABLED", value = var.slack_triggers_enabled ? "true" : "false" },
  ]

  secrets = [
    { name = "SLACK_BOT_TOKEN", value = var.slack_bot_token },
    { name = "SLACK_SIGNING_SECRET", value = var.slack_signing_secret },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "SERVICE_AUTH_SECRET", value = random_password.service_auth_secret_slack_bot.result },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.slack_bot_build[0], module.slack_kv[0]]
}

resource "cloudflare_queue_consumer" "slack_completion_delivery" {
  count = var.enable_slack_bot ? 1 : 0

  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.slack_completion_delivery[0].queue_id
  type              = "worker"
  script_name       = module.slack_bot_worker[0].worker_name
  dead_letter_queue = cloudflare_queue.slack_completion_delivery_dlq[0].queue_name
  settings = {
    batch_size       = 1
    max_wait_time_ms = 1000
    max_concurrency  = 5
    max_retries      = 1
    retry_delay      = 15
  }

  depends_on = [module.slack_bot_worker]
}
