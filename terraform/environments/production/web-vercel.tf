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

  environment_variables = concat(
    local.vercel_scm_environment_variables,
    [
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
      {
        key       = "INTERNAL_CALLBACK_SECRET"
        value     = var.internal_callback_secret
        targets   = ["production", "preview"]
        sensitive = true
      },
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
  )
}
