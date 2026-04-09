# =============================================================================
# Modal Sandbox Infrastructure
# =============================================================================

# Calculate hash of Modal source files for change detection
# Uses sha256sum (Linux) or shasum (macOS) for cross-platform compatibility
# Includes .py, .js, and .ts files (sandbox plugins and tools)
data "external" "modal_source_hash" {
  count = local.use_modal_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}
    if command -v sha256sum &> /dev/null; then
      hash=$(find packages/modal-infra/src packages/sandbox-runtime/src -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \) -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
    else
      hash=$(find packages/modal-infra/src packages/sandbox-runtime/src -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \) -exec shasum -a 256 {} \; | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "modal_app" {
  count  = local.use_modal_backend ? 1 : 0
  source = "../../modules/modal-app"

  modal_token_id     = var.modal_token_id
  modal_token_secret = var.modal_token_secret

  app_name      = "open-inspect"
  workspace     = var.modal_workspace
  deploy_path   = "${var.project_root}/packages/modal-infra"
  deploy_module = "deploy"
  source_hash   = data.external.modal_source_hash[0].result.hash

  volume_name = "open-inspect-data"

  secrets = [
    {
      name = "llm-api-keys"
      values = {
        ANTHROPIC_API_KEY = var.anthropic_api_key
      }
    },
    {
      name = "github-app"
      values = {
        GITHUB_APP_ID              = var.github_app_id
        GITHUB_APP_PRIVATE_KEY     = var.github_app_private_key
        GITHUB_APP_INSTALLATION_ID = var.github_app_installation_id
      }
    },
    {
      name = "internal-api"
      values = {
        MODAL_API_SECRET            = var.modal_api_secret
        INTERNAL_CALLBACK_SECRET    = var.internal_callback_secret
        ALLOWED_CONTROL_PLANE_HOSTS = local.control_plane_host
        CONTROL_PLANE_URL           = local.control_plane_url
      }
    }
  ]
}
