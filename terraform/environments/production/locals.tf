locals {
  name_suffix         = var.deployment_name
  use_modal_backend   = var.sandbox_provider == "modal"
  use_daytona_backend = var.sandbox_provider == "daytona"
  use_vercel_backend  = var.sandbox_provider == "vercel"

  # Default workers.dev hostnames. They remain reachable even after a custom
  # domain is bound, so they double as fallbacks.
  default_control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  default_web_app_host       = "open-inspect-web-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"

  # Resolved control plane host — custom domain when set, workers.dev otherwise.
  control_plane_host = var.control_plane_domain != "" ? var.control_plane_domain : local.default_control_plane_host
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  # Web app URL: custom domain on Cloudflare path, or workers.dev / Vercel default
  web_app_url = var.web_platform == "cloudflare" ? (
    var.web_app_domain != "" ? "https://${var.web_app_domain}" : "https://${local.default_web_app_host}"
    ) : (
    "https://open-inspect-${local.name_suffix}.vercel.app"
  )

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
}
