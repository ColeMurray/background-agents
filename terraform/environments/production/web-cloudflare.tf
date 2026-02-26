# =============================================================================
# Web App — Cloudflare Workers via OpenNext (when web_platform = "cloudflare")
# =============================================================================

# Build the web app with OpenNext for Cloudflare Workers
resource "null_resource" "web_app_cloudflare_build" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build -w @open-inspect/shared && npm run build:cloudflare -w @open-inspect/web"
    working_dir = var.project_root

    environment = {
      # NEXT_PUBLIC_* vars must be set at build time (inlined into client bundle)
      NEXT_PUBLIC_WS_URL = local.ws_url
    }
  }
}

# Upload secrets to the Cloudflare Worker (only re-runs when secrets change).
# Must run after deploy — wrangler secret put requires the worker to exist.
resource "null_resource" "web_app_cloudflare_secrets" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    secrets_hash = sha256(join(",", [
      var.github_client_secret,
      var.nextauth_secret,
      var.internal_callback_secret,
    ]))
  }

  provisioner "local-exec" {
    command     = "bash scripts/wrangler-secrets.sh"
    working_dir = var.project_root

    environment = {
      CLOUDFLARE_API_TOKEN     = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID    = var.cloudflare_account_id
      WORKER_NAME              = "open-inspect-web-${local.name_suffix}"
      GITHUB_CLIENT_SECRET     = var.github_client_secret
      NEXTAUTH_SECRET          = var.nextauth_secret
      INTERNAL_CALLBACK_SECRET = var.internal_callback_secret
    }
  }

  depends_on = [null_resource.web_app_cloudflare_deploy]
}

# Generate a production wrangler config with the correct service binding name.
# This avoids mutating the checked-in wrangler.toml (which defaults to local dev).
resource "local_file" "web_app_wrangler_production" {
  count    = var.web_platform == "cloudflare" ? 1 : 0
  filename = "${var.project_root}/packages/web/wrangler.production.toml"
  content  = <<-TOML
    name = "open-inspect-web-${local.name_suffix}"
    main = ".open-next/worker.js"
    compatibility_date = "2025-08-15"
    compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

    [vars]
    GITHUB_CLIENT_ID = "${var.github_client_id}"
    NEXTAUTH_URL = "${local.web_app_url}"
    CONTROL_PLANE_URL = "${local.control_plane_url}"
    NEXT_PUBLIC_WS_URL = "${local.ws_url}"
    ALLOWED_USERS = "${var.allowed_users}"
    ALLOWED_EMAIL_DOMAINS = "${var.allowed_email_domains}"

    [assets]
    directory = ".open-next/assets"
    binding = "ASSETS"

    [[services]]
    binding = "CONTROL_PLANE_WORKER"
    service = "open-inspect-control-plane-${local.name_suffix}"
  TOML
}

# Deploy the OpenNext bundle to Cloudflare Workers
resource "null_resource" "web_app_cloudflare_deploy" {
  count = var.web_platform == "cloudflare" ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npx wrangler deploy --config wrangler.production.toml"
    working_dir = "${var.project_root}/packages/web"

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [
    null_resource.web_app_cloudflare_build,
    module.control_plane_worker,
    local_file.web_app_wrangler_production,
  ]
}
