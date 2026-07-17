# =============================================================================
# Superserve Sandbox Infrastructure
# =============================================================================

data "external" "superserve_source_hash" {
  count = local.use_superserve_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    set -euo pipefail
    cd "${var.project_root}"
    paths=(
      packages/sandbox-runtime/src
      packages/sandbox-runtime/pyproject.toml
      packages/superserve-infra/src/build-template.ts
      packages/superserve-infra/package.json
      package-lock.json
    )
    if command -v sha256sum &> /dev/null; then
      hash=$(find "$${paths[@]}" -type f \
        -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' -not -path '*/.ruff_cache/*' \
        -not -name '*.pyc' -not -name '.DS_Store' \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find "$${paths[@]}" -type f \
        -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' -not -path '*/.ruff_cache/*' \
        -not -name '*.pyc' -not -name '.DS_Store' \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "superserve_infra" {
  count  = local.use_superserve_backend ? 1 : 0
  source = "../../modules/superserve-infra"

  api_url         = var.superserve_api_url
  api_key         = var.superserve_api_key
  manual_template = var.superserve_template
  project_root    = var.project_root
  source_hash     = data.external.superserve_source_hash[0].result.hash
}
