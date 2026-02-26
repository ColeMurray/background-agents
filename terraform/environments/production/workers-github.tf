# =============================================================================
# GitHub Bot Worker
# =============================================================================

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
