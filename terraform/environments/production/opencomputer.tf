# =============================================================================
# OpenComputer Sandbox Infrastructure
# =============================================================================

# Calculate hash of OpenComputer base snapshot source files for change detection.
# Includes the shared sandbox-runtime plus the OpenComputer image builder that bakes it in.
data "external" "opencomputer_source_hash" {
  count = local.use_opencomputer_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd "${var.project_root}"
    paths=(
      packages/sandbox-runtime/pyproject.toml
      packages/sandbox-runtime/src
      packages/opencomputer-infra/src/build-template.ts
    )
    if command -v sha256sum &> /dev/null; then
      hash=$(find "$${paths[@]}" -type f \
        \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "pyproject.toml" \) \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find "$${paths[@]}" -type f \
        \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "pyproject.toml" \) \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "opencomputer_infra" {
  count  = local.use_opencomputer_backend ? 1 : 0
  source = "../../modules/opencomputer-infra"

  api_url            = var.opencomputer_api_url
  api_key            = var.opencomputer_api_key
  manual_snapshot_id = var.opencomputer_template
  project_root       = var.project_root
  source_hash        = data.external.opencomputer_source_hash[0].result.hash
}
