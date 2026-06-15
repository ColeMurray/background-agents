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
    # GitHub OAuth
    {
      key       = "GITHUB_CLIENT_ID"
      value     = var.github_client_id
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "GITHUB_CLIENT_SECRET"
      value     = var.github_client_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # NextAuth
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
      key       = "INTERNAL_CALLBACK_SECRET"
      value     = var.internal_callback_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # Access Control
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
    {
      key       = "UNSAFE_ALLOW_ALL_USERS"
      value     = tostring(var.unsafe_allow_all_users)
      targets   = ["production", "preview"]
      sensitive = false
    },
    # New env vars MUST be appended here. The module's env-var resource is
    # count-indexed by list position (modules/vercel-project/main.tf uses count,
    # because Vercel values are sensitive and can't be for_each keys), so
    # inserting mid-list renumbers every downstream var and forces Vercel to
    # destroy/recreate them — which races into ENV_CONFLICT. Appending keeps
    # existing indices stable.
    # Google OAuth (optional; both empty for GitHub-only deployments)
    {
      key       = "GOOGLE_CLIENT_ID"
      value     = var.google_client_id
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "GOOGLE_CLIENT_SECRET"
      value     = var.google_client_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    # Build-time flag that reveals the "Sign in with Google" button. Inlined into
    # the client bundle, so it must be present at build time (not just runtime).
    {
      key       = "NEXT_PUBLIC_GOOGLE_ENABLED"
      value     = tostring(local.google_enabled)
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "ALLOWED_EMAILS"
      value     = var.allowed_emails
      targets   = ["production", "preview"]
      sensitive = false
    },
  ]
}
