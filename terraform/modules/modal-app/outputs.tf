output "app_name" {
  description = "The name of the deployed Modal app"
  value       = var.app_name
}

output "deploy_id" {
  description = "ID of the deployment resource (for dependency tracking)"
  value       = null_resource.modal_deploy.id
}

output "api_health_url" {
  description = "URL of the health check endpoint"
  value       = "https://${local.modal_workspace_slug}--${var.app_name}-api-health.modal.run"
}

output "api_create_sandbox_url" {
  description = "URL of the create sandbox endpoint"
  value       = "https://${local.modal_workspace_slug}--${var.app_name}-api-create-sandbox.modal.run"
}
