output "snapshot_build_id" {
  description = "ID of the snapshot build resource (for depends_on references)"
  value       = null_resource.boat_snapshot.id
}

output "snapshot_name" {
  description = "Verified saved snapshot; only switch traffic after the build succeeds"
  value       = local.snapshot_name
  depends_on  = [null_resource.boat_snapshot]
}
