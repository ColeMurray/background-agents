output "project_id" {
  description = "The ID of the Vercel project"
  value       = vercel_project.this.id
}

output "project_name" {
  description = "The name of the Vercel project"
  value       = vercel_project.this.name
}

output "production_url" {
  description = "The production URL of the project"
  value       = "https://${vercel_project.this.name}.vercel.app"
}

output "custom_domain" {
  description = "The custom domain (if configured)"
  value       = var.custom_domain != null ? vercel_project_domain.this[0].domain : null
}

output "root_directory" {
  description = "The repository directory the project builds from"
  value       = var.root_directory
}
