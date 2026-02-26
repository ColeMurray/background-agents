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
