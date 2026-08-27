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

  api_key            = var.e2b_api_key
  api_url            = var.e2b_api_url
  template_id        = var.e2b_template_id
  template_cpu       = var.e2b_template_cpu
  template_memory_mb = var.e2b_template_memory_mb
  deploy_path        = "${var.project_root}/packages/e2b-infra"
  source_hash        = data.external.e2b_source_hash[0].result.hash

  # Deploy the worker BEFORE rebuilding the template (the reverse of the other
  # sandbox modules, whose workers consume module outputs). The worker binds
  # only var.e2b_template_id, so this edge is free to point either way — and
  # worker-first is the compatible order: the new control plane boots the old
  # launcher-bearing template fine (the captured launcher just idles unfed),
  # while an old control plane cannot boot a launcher-less template. It also
  # fails safe: a failed template rebuild leaves a fully working system, where
  # template-first plus a failed worker deploy would leave sessions AND image
  # builds down until a re-apply.
  #
  # Known trade: on FIRST enablement or an e2b_template_id rotation, the worker
  # briefly points at a template that does not exist yet (creates 404 until the
  # build lands — and until a re-apply if the build fails). Template-first
  # would protect that rare, operator-initiated case, but would re-arm the
  # broken upgrade window above for every deployer crossing the direct-boot
  # change in one apply.
  depends_on = [module.control_plane_worker]
}
