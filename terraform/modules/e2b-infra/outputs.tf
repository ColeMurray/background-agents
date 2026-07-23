output "template_build_id" {
  description = "ID of the template build resource (for depends_on references)"
  value       = null_resource.e2b_template.id
}
