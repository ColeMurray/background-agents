# =============================================================================
# Discord Bot Worker
# =============================================================================

# Build discord-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "discord_bot_build" {
  count = var.enable_discord_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/discord-bot"
  }
}

module "discord_bot_worker" {
  count  = var.enable_discord_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-discord-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
  script_path      = local.discord_bot_script_path

  kv_namespaces = {
    DISCORD_KV = {
      namespace_id = module.discord_kv[0].namespace_id
    }
  }

  service_bindings = {
    CONTROL_PLANE = {
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  }

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = {
    WEB_APP_URL                 = { value = local.web_app_url }
    DEPLOYMENT_NAME             = { value = var.deployment_name }
    APP_NAME                    = { value = var.app_name }
    DEFAULT_MODEL               = { value = var.discord_bot_default_model }
    HARNESS                     = { value = var.discord_bot_harness }
    DISCORD_APPLICATION_ID      = { value = var.discord_application_id }
    DISCORD_PUBLIC_KEY          = { value = var.discord_public_key }
    DISCORD_ALLOWED_ROLE_IDS    = { value = var.discord_allowed_role_ids }
    DISCORD_ALLOWED_CHANNEL_IDS = { value = var.discord_allowed_channel_ids }
  }

  secrets = {
    DISCORD_BOT_TOKEN   = { value = var.discord_bot_token }
    SERVICE_AUTH_SECRET = { value = random_password.service_auth_secret_discord_bot.result }
  }

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.discord_bot_build[0], module.discord_kv[0]]
}
