output "snapshot_build_id" {
  description = "ID of the snapshot build resource (for depends_on references)"
  value       = null_resource.daytona_snapshot.id
}

output "snapshot_name" {
  description = "Verified snapshot name; only switch traffic after the build succeeds"
  value       = var.snapshot_name
  depends_on  = [null_resource.daytona_snapshot]
}
