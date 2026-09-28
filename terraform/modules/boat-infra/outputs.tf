output "snapshot_name" {
  description = "Verified immutable Boat named snapshot"
  value       = var.snapshot_name
  depends_on  = [null_resource.boat_template]
}

output "template_build_id" {
  description = "Template build resource id"
  value       = null_resource.boat_template.id
}
