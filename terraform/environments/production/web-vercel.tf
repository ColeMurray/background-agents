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
    {
      key       = "NEXT_PUBLIC_SANDBOX_PROVIDER"
      value     = var.sandbox_provider
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_APP_NAME"
      value     = var.app_name
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_APP_SHORT_NAME"
      value     = var.app_short_name
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_APP_ICON_URL"
      value     = var.app_icon_url
      targets   = ["production", "preview"]
      sensitive = false
    },
    # Internal
    {
      key       = "SERVICE_AUTH_SECRET"
      value     = random_password.service_auth_secret_web.result
      targets   = ["production", "preview"]
      sensitive = true
    },
    # This cutover intentionally removes the legacy web-owned auth variables,
    # so the first apply replaces the module's count-indexed env resources.
    # After that one-time transition, append new variables to keep indices
    # stable and avoid Vercel ENV_CONFLICT replacement races.
    # Build-time flag that reveals the "Sign in with Google" button. Inlined into
    # the client bundle, so it must be present at build time (not just runtime).
    {
      key       = "NEXT_PUBLIC_GOOGLE_ENABLED"
      value     = tostring(local.google_enabled)
      targets   = ["production", "preview"]
      sensitive = false
    },
  ]
}
