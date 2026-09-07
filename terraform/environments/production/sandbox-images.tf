# The Git-tracked lock is the durable promotion and rollback history.
# Native builds emit candidates; changing this lock selects a verified artifact.
locals {
  sandbox_image_lock = jsondecode(file("${path.module}/sandbox-images.lock.json"))
  sandbox_selected_records = {
    for provider, release_id in local.sandbox_image_lock.selected :
    provider => local.sandbox_image_lock.releases[release_id]
  }
  sandbox_base_releases = module.sandbox_image_selection.releases
}

module "sandbox_image_selection" {
  source   = "../../modules/sandbox-image-selection"
  releases = local.sandbox_selected_records
}

output "sandbox_image_candidate_files" {
  description = "Non-secret verified build records to review and promote with sandbox:images promote"
  value       = "${var.project_root}/.cache/sandbox-image-candidates/"
}
