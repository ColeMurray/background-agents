# =============================================================================
# Teams Bot Worker
# =============================================================================

# Build teams-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "teams_bot_build" {
  count = var.enable_teams_bot ? 1 : 0

  triggers = {
    # Rebuild when source files change - use timestamp to always check
    # In CI, this ensures fresh builds; locally, npm handles caching
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/teams-bot"
  }
}

module "teams_bot_worker" {
  count  = var.enable_teams_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-teams-bot-${local.name_suffix}"
  script_path = local.teams_bot_script_path

  kv_namespaces = [
    {
      binding_name = "TEAMS_KV"
      namespace_id = module.teams_kv[0].namespace_id
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
    { name = "MICROSOFT_APP_ID", value = var.microsoft_app_id },
    { name = "MICROSOFT_TENANT_ID", value = var.microsoft_tenant_id },
  ]

  secrets = [
    { name = "MICROSOFT_APP_PASSWORD", value = var.microsoft_app_password },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.teams_bot_build[0], module.teams_kv[0]]
}
