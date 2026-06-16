locals {
  name_suffix         = var.deployment_name
  use_modal_backend   = var.sandbox_provider == "modal"
  use_daytona_backend = var.sandbox_provider == "daytona"
  use_vercel_backend  = var.sandbox_provider == "vercel"

  # Google login is enabled only when both OAuth credentials are configured.
  # Drives the build-time NEXT_PUBLIC_GOOGLE_ENABLED flag (sign-in button) and
  # mirrors the server-side conditional GoogleProvider in packages/web/src/lib/auth.ts.
  google_enabled = trimspace(var.google_client_id) != "" && trimspace(var.google_client_secret) != ""

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  # Web app URL depends on deployment platform
  web_app_url = var.web_platform == "cloudflare" ? (
    "https://open-inspect-web-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
    ) : (
    "https://open-inspect-${local.name_suffix}.vercel.app"
  )

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
  email_bot_script_path     = "${var.project_root}/packages/email-bot/dist/index.js"
}
