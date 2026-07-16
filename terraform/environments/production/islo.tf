# =============================================================================
# Islo Sandbox Infrastructure
# =============================================================================

# Calculate hash of Islo snapshot source files for change detection.
# Includes islo-infra (snapshot definition) and sandbox-runtime (copied into snapshot).
data "external" "islo_source_hash" {
  count = local.use_islo_backend && trimspace(var.islo_base_snapshot) != "" ? 1 : 0

  program = ["bash", "-c", <<-EOF
    set -euo pipefail
    project_root=${jsonencode(var.project_root)}
    cd "$project_root"
    files=$( {
      find packages/islo-infra/src packages/sandbox-runtime/src \
        -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \)
      find packages/islo-infra packages/sandbox-runtime \
        -maxdepth 2 -type f \( \
          -name "package.json" -o \
          -name "package-lock.json" -o \
          -name "pnpm-lock.yaml" -o \
          -name "yarn.lock" -o \
          -name "pyproject.toml" -o \
          -name "uv.lock" -o \
          -name "tsconfig.json" -o \
          -name "Dockerfile" \
        \)
      find packages/islo-infra packages/sandbox-runtime \
        -type f \( -path "*/bin/*" -o -path "*/scripts/*" \)
    } | sort -u)
    if command -v sha256sum &> /dev/null; then
      hash=$(printf '%s\n' "$files" | xargs sha256sum | sha256sum | cut -d' ' -f1)
    else
      hash=$(printf '%s\n' "$files" | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "islo_infra" {
  count  = local.use_islo_backend && trimspace(var.islo_base_snapshot) != "" ? 1 : 0
  source = "../../modules/islo-infra"

  api_key       = var.islo_api_key
  base_url      = var.islo_base_url
  snapshot_name = var.islo_base_snapshot
  deploy_path   = "${var.project_root}/packages/islo-infra"
  source_hash   = data.external.islo_source_hash[0].result.hash
}
