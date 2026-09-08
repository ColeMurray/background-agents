output "template_build_id" {
  description = "ID of the template build resource (for depends_on references)"
  value       = null_resource.e2b_template.id
}

output "template_id" {
  description = "Verified template alias; only switch traffic after the build succeeds"
  value       = var.template_id
  depends_on  = [null_resource.e2b_template]
}
