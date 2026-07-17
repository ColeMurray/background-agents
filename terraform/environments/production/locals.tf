locals {
  name_suffix              = var.deployment_name
  use_modal_backend        = var.sandbox_provider == "modal"
  use_daytona_backend      = var.sandbox_provider == "daytona"
  use_vercel_backend       = var.sandbox_provider == "vercel"
  use_opencomputer_backend = var.sandbox_provider == "opencomputer"
  use_e2b_backend          = var.sandbox_provider == "e2b"
  use_superserve_backend   = var.sandbox_provider == "superserve"

  # Google login is enabled only when both OAuth credentials are configured.
  # Drives the build-time NEXT_PUBLIC_GOOGLE_ENABLED flag (sign-in button) and
  # mirrors the server-side conditional GoogleProvider in packages/web/src/lib/auth.ts.
  google_enabled = trimspace(var.google_client_id) != "" && trimspace(var.google_client_secret) != ""

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  # Must match the deployed Worker's `name` and the custom-domain `service` binding.
  web_worker_name = "open-inspect-web-${local.name_suffix}"

  # Custom-domain inputs normalized to "" when unset. coalesce() must not be
  # used here: it errors when all arguments are null or empty strings, which is
  # the default for both variables.
  web_custom_domain         = var.cloudflare_custom_domain == null ? "" : trimspace(var.cloudflare_custom_domain)
  web_custom_domain_zone_id = var.cloudflare_zone_id == null ? "" : trimspace(var.cloudflare_zone_id)

  # Whether a custom domain is configured for the Cloudflare web Worker
  web_custom_domain_enabled = (
    var.web_platform == "cloudflare" &&
    local.web_custom_domain != "" &&
    local.web_custom_domain_zone_id != ""
  )

  # Host the Cloudflare web Worker is served from: custom domain when configured,
  # otherwise its default workers.dev hostname.
  web_cloudflare_host = (local.web_custom_domain_enabled
    ? local.web_custom_domain
    : "${local.web_worker_name}.${var.cloudflare_worker_subdomain}.workers.dev"
  )

  # Web app URL depends on deployment platform
  web_app_url = (var.web_platform == "cloudflare"
    ? "https://${local.web_cloudflare_host}"
    : "https://open-inspect-${local.name_suffix}.vercel.app"
  )

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
}
