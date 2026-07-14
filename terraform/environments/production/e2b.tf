# =============================================================================
# E2B Sandbox Infrastructure
# =============================================================================

# Calculate hash of E2B template source files for change detection.
# Includes e2b-infra (Dockerfile + launcher) and sandbox-runtime (staged into the image).
data "external" "e2b_source_hash" {
  count = local.use_e2b_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}
    if command -v sha256sum &> /dev/null; then
      hash=$(find packages/e2b-infra packages/sandbox-runtime/src \
        -type f \
        -not -path 'packages/e2b-infra/.venv/*' -not -path 'packages/e2b-infra/sandbox_runtime/*' -not -path '*/__pycache__/*' \
        \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "Dockerfile*" -o -name "*.Dockerfile" -o -name "*.toml" -o -name "uv.lock" -o -name "*.sh" \) \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find packages/e2b-infra packages/sandbox-runtime/src \
        -type f \
        -not -path 'packages/e2b-infra/.venv/*' -not -path 'packages/e2b-infra/sandbox_runtime/*' -not -path '*/__pycache__/*' \
        \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "Dockerfile*" -o -name "*.Dockerfile" -o -name "*.toml" -o -name "uv.lock" -o -name "*.sh" \) \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "e2b_infra" {
  count  = local.use_e2b_backend ? 1 : 0
  source = "../../modules/e2b-infra"

  api_key     = var.e2b_api_key
  api_url     = var.e2b_api_url
  template_id = var.e2b_template_id
  deploy_path = "${var.project_root}/packages/e2b-infra"
  source_hash = data.external.e2b_source_hash[0].result.hash
}
