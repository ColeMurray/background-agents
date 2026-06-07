# =============================================================================
# Islo Sandbox Infrastructure
# =============================================================================

# Calculate hash of Islo snapshot source files for change detection.
# Includes islo-infra (snapshot definition) and sandbox-runtime (copied into snapshot).
data "external" "islo_source_hash" {
  count = local.use_islo_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}
    if command -v sha256sum &> /dev/null; then
      hash=$(find packages/islo-infra/src packages/sandbox-runtime/src \
        -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \) \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find packages/islo-infra/src packages/sandbox-runtime/src \
        -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \) \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "islo_infra" {
  count  = local.use_islo_backend ? 1 : 0
  source = "../../modules/islo-infra"

  api_key       = var.islo_api_key
  base_url      = var.islo_base_url
  snapshot_name = var.islo_base_snapshot
  deploy_path   = "${var.project_root}/packages/islo-infra"
  source_hash   = data.external.islo_source_hash[0].result.hash
}
