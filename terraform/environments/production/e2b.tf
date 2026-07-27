# =============================================================================
# E2B Sandbox Infrastructure
# =============================================================================

# Calculate hash of E2B template source files for change detection.
# build-template.py stages the WHOLE sandbox_runtime tree into the image (not just
# *.py/.ts — skill prompts, assets, etc.), so hash every file under the runtime and
# the e2b-infra builder, excluding only generated/cache dirs. Exclude-only policy,
# mirroring the opencomputer builder, so a skill-only change still rebuilds the template.
data "external" "e2b_source_hash" {
  count = local.use_e2b_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}
    if command -v sha256sum &> /dev/null; then
      hash=$(find packages/e2b-infra packages/sandbox-runtime/src \
        -type f \
        -not -path 'packages/e2b-infra/.venv/*' -not -path 'packages/e2b-infra/sandbox_runtime/*' \
        -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' -not -path '*/.ruff_cache/*' \
        -not -name '*.pyc' -not -name '.DS_Store' \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find packages/e2b-infra packages/sandbox-runtime/src \
        -type f \
        -not -path 'packages/e2b-infra/.venv/*' -not -path 'packages/e2b-infra/sandbox_runtime/*' \
        -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' -not -path '*/.ruff_cache/*' \
        -not -name '*.pyc' -not -name '.DS_Store' \
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
