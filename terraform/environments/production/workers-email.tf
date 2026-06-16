# =============================================================================
# AgentMail Email Bot Worker
# =============================================================================

resource "null_resource" "email_bot_build" {
  count = var.enable_email_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/email-bot"
  }
}

module "email_bot_worker" {
  count  = var.enable_email_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-email-bot-${local.name_suffix}"
  script_path = local.email_bot_script_path

  kv_namespaces = [
    {
      binding_name = "EMAIL_KV"
      namespace_id = module.email_kv[0].namespace_id
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
    { name = "APP_NAME", value = var.app_name },
    { name = "DEFAULT_MODEL", value = "claude-sonnet-4-6" },
    { name = "AGENTMAIL_API_BASE_URL", value = var.agentmail_api_base_url },
    { name = "EMAIL_ROUTES_JSON", value = var.email_routes_json },
  ]

  secrets = [
    { name = "AGENTMAIL_API_KEY", value = var.agentmail_api_key },
    { name = "AGENTMAIL_WEBHOOK_SECRET", value = var.agentmail_webhook_secret },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.email_bot_build[0], module.email_kv[0]]
}
