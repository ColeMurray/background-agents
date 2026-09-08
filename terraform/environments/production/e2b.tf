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

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "e2b"]
}

module "e2b_infra" {
  count  = local.use_e2b_backend ? 1 : 0
  source = "../../modules/e2b-infra"

  api_key            = var.e2b_api_key
  api_url            = var.e2b_api_url
  template_id        = "${var.e2b_template_id}-${substr(sha256("${data.external.e2b_source_hash[0].result.hash}:${var.e2b_template_cpu}:${var.e2b_template_memory_mb}"), 0, 16)}"
  template_cpu       = var.e2b_template_cpu
  template_memory_mb = var.e2b_template_memory_mb
  deploy_path        = "${var.project_root}/packages/e2b-infra"
  source_hash        = data.external.e2b_source_hash[0].result.hash

  # Build and verify the new alias before switching the existing Worker binding.
  # Existing aliases remain intact if construction or deployment fails.
}
