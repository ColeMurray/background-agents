output "snapshot_build_id" {
  description = "ID of the snapshot build resource (for depends_on references)"
  value       = null_resource.islo_snapshot.id
}
