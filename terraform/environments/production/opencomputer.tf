# =============================================================================
# OpenComputer Sandbox Infrastructure
# =============================================================================

# Calculate hash of OpenComputer base snapshot source files for change detection.
# Includes the shared sandbox-runtime plus the OpenComputer image builder that bakes it in.
data "external" "opencomputer_source_hash" {
  count = local.use_opencomputer_backend ? 1 : 0

  # Hash every file the image actually bakes in: build-template.ts copies the whole
  # sandbox-runtime tree via collectRuntimeFiles (not just *.py/.js/.ts — skill prompts,
  # assets, etc.), so mirror its include/exclude policy here, and add the builder + its
  # dependency manifests so an SDK/toolchain bump also invalidates the snapshot.
  program = ["bash", "-c", <<-EOF
    set -euo pipefail
    cd "${var.project_root}"
    paths=(
      packages/sandbox-runtime/src
      packages/sandbox-runtime/pyproject.toml
      packages/opencomputer-infra/src/build-template.ts
      packages/opencomputer-infra/package.json
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

module "opencomputer_infra" {
  count  = local.use_opencomputer_backend ? 1 : 0
  source = "../../modules/opencomputer-infra"

  api_url            = var.opencomputer_api_url
  api_key            = var.opencomputer_api_key
  manual_snapshot_id = var.opencomputer_template
  project_root       = var.project_root
  source_hash        = data.external.opencomputer_source_hash[0].result.hash
}
