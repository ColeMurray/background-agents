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
  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "opencomputer"]
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
