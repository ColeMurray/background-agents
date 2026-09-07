# The Git-tracked lock is the durable promotion and rollback history.
# Native builds emit candidates; changing this lock selects a verified artifact.
locals {
  sandbox_image_lock = jsondecode(file("${path.module}/sandbox-images.lock.json"))
  sandbox_base_releases = {
    for provider, release_id in local.sandbox_image_lock.selected :
    provider => local.sandbox_image_lock.releases[release_id]
  }
}

output "sandbox_image_candidate_files" {
  description = "Non-secret verified build records to review and promote with sandbox:images promote"
  value       = "${var.project_root}/.cache/sandbox-image-candidates/"
}
